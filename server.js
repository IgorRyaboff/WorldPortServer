#!/usr/bin/env node

const version = require('./package.json').version;
const net = require('net');
const tls = require('tls');
const http = require('http');
const websocket = require('websocket');
const fs = require('fs');
const Express = require('express');
const https = require('https');
const { ThrottleGroup } = require('stream-throttle');
const path = require('path');
require('dotenv-defaults').config({
    defaults: './.env.defaults'
});;
const tlsOptions = {
    key: fs.readFileSync(process.env.tlsKey),
    cert: fs.readFileSync(process.env.tlsCert)
};
if (process.env.tlsCA) tlsOptions.ca = fs.readFileSync(process.env.tlsCA);

let users = {};
if (process.env.usersList && fs.existsSync(process.env.usersList)) users = require(process.env.usersList);
global.u = users;

function makeid(length) {
    var result = [];
    var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var charactersLength = characters.length;
    for (var i = 0; i < length; i++) {
        result.push(characters.charAt(Math.floor(Math.random() *
            charactersLength)));
    }
    return result.join('');
}

function randomInteger(min, max) {
    let rand = min - 0.5 + Math.random() * (max - min + 1);
    return Math.round(rand);
}

function formatDate(date) {
    const adjustZeros = (x, required = 2) => {
        x = String(x);
        while (x.length < required) x = '0' + x;
        return x;
    }
    if (!(date instanceof Date)) date = new Date(+date);

    let Y = date.getFullYear();
    let M = adjustZeros(date.getMonth() + 1);
    let D = adjustZeros(date.getDate());

    let h = adjustZeros(date.getHours());
    let m = adjustZeros(date.getMinutes());
    let s = adjustZeros(date.getUTCSeconds());
    let ms = adjustZeros(date.getMilliseconds(), 3);

    return `${D}.${M}.${Y} ${h}:${m}:${s}.${ms}`;
}
function log(...args) {
    console.log(`[${formatDate(new Date)}]`, ...args);
}

class Session {
    id = '';
    token = '';
    externalPort = 0;

    #isOpened = true;
    get isOpened() {
        return this.#isOpened;
    }
    set isOpened(value) {
        if (this.#isOpened && !value) this.#isOpened = false;
    }

    get externalPort() {
        return this.externalPort;
    }
    set externalPort(value) {
        if (!this.externalPort) this.externalPort = value;
    }

    /**
     * @type {Object<string, [ net.Socket, net.Socket, Buffer[] ]>}
     */
    sockets = {};

    /**
     * @type {websocket.connection}
     */
    #apiSocket;
    #apiSocketBuffer = [];
    #apiSocketReconTO;

    /**
     * @type {ThrottleGroup}
     */
    #throttleGroup;

    /**
     * @type {net.Server}
     */
    #server;
    /**
     * @type {net.Server}
     */
    #s2Server;

    user;

    constructor(id, token, port, apiSocket, user) {
        log(`New session #${id} on ext port ${port}, user: ${user ? '"' + user + '"' : '<anon>'}`);
        this.id = id;
        this.token = token;
        this.user = user;
        this.externalPort = parseInt(port);
        if ((+process.env.bandwidthLimit) && !users[this.user]?.ignoreBandwidthLimit) this.#throttleGroup = new ThrottleGroup({ rate: 1024 * 1024 * (+process.env.bandwidthLimit) / 8 });
        //log(`BW limit for ${user}`, (+process.env.bandwidthLimit), users[this.user], users[this.user]?.ignoreBandwidthLimit, !!this.#throttleGroup);

        this.#server = net.createServer(s1 => {
            let id = makeid(2);
            while (this.sockets[id]) id = makeid(2);
            if (process.env.debug == 1) log(`S1 ${id}@${this.id} created`);
            if ((+process.env.bandwidthLimit) && !users[this.user]?.ignoreBandwidthLimit) {
                let throttledS1 = this.#throttleGroup.throttle();
                throttledS1.pipe(s1);
                this.sockets[id] = [throttledS1, false, []];
            }
            else this.sockets[id] = [s1, false, []];

            s1.on('data', chunk => {
                if (!this.sockets[id]) return;
                if (this.sockets[id][1]) this.sockets[id][1].write(chunk);
                else this.sockets[id][2].push(chunk);
            });

            s1.on('error', () => { });
            s1.on('close', () => {
                if (process.env.debug == 1) log(`S1 ${id}@${this.id} destroyed`);
                if (this.sockets[id]) {
                    if (this.sockets[id][1]) this.sockets[id][1].end();
                    delete this.sockets[id];
                }
            });

            this.send('s2.create', {
                id: id
            });
        });
        this.#server.listen(this.externalPort);

        this.#s2Server = tls.createServer(tlsOptions, s2 => {
            let id;
            s2.on('data', chunk => {
                if (id && this.sockets[id]) this.sockets[id][0].write(chunk);
                else {
                    id = chunk.toString();
                    if (this.sockets[id]) {
                        if ((+process.env.bandwidthLimit) && !users[this.user]?.ignoreBandwidthLimit) {
                            let throttledS2 = this.#throttleGroup.throttle();
                            throttledS2.pipe(s2);
                            this.sockets[id][1] = throttledS2;
                        }
                        else this.sockets[id][1] = s2;
                        this.sockets[id][2].forEach(chunk => this.sockets[id][1].write(chunk));
                        if (process.env.debug == 1) log(`S2 ${id}@${this.id} created`);
                    }
                    else s2.end();
                }
            });

            s2.on('error', () => { });
            s2.on('close', () => {
                if (process.env.debug == 1) log(`S2 ${id}@${this.id} destroyed`);
                if (this.sockets[id]) this.sockets[id][0].end();
                delete this.sockets[id];
            });
        });
        this.#s2Server.listen(this.externalPort + 10000);
        this.initAPISocket(apiSocket);
    }

    /**
     * 
     * @param {websocket.connection} con
     */
    initAPISocket(con) {
        if (!this.isOpened) return;
        if (this.#apiSocket) this.#apiSocket.close(4000);
        clearTimeout(this.#apiSocketReconTO);
        let lastAliveCheck = new Date;
        let aliveCheckInterval = setInterval(() => {
            this.send('aliveCheck');
        }, (+process.env.aliveCheckInterval));
        let aliveCheckTimeoutChecker = setInterval(() => {
            if (new Date - lastAliveCheck >= (+process.env.aliveCheckTimeout)) {
                log('AliveCheck timed out. Connection will be closed, session ' + this.id);
                con.close();
            }
        }, 1000);
        con.on('message', msg => {
            let data;
            try {
                data = JSON.parse(msg.utf8Data);
            }
            catch (_e) { }

            if (!data || !data._e) return;
            if (process.env.debug == 1) log(`${this.id}: ${data._e}`);
            switch (data._e) {
                case 'aliveCheck': {
                    lastAliveCheck = new Date;
                    break;
                }
            }
        });
        con.on('error', e => {
            log(`Error in apiSocket: ${e}`);
        });
        con.on('close', code => {
            this.#apiSocket = false;
            if (code == 1000) this.end();
            else this.#apiSocketReconTO = setTimeout(() => {
                this.end();
            }, 10000);
            clearInterval(aliveCheckInterval);
            clearInterval(aliveCheckTimeoutChecker);
        });
        this.#apiSocket = con;
        this.#apiSocketBuffer.forEach(m => this.send(m._e, m));
        this.#apiSocketBuffer = [];
        this.send('session.created', {
            id: this.id,
            port: this.externalPort,
            token: this.token,
            v: version,
            aliveCheckInterval: (+process.env.aliveCheckInterval),
            aliveCheckTimeout: (+process.env.aliveCheckTimeout),
            bandwidthLimit: this.#throttleGroup ? (+process.env.bandwidthLimit) : 0
        });
    }

    send(e, data = {}) {
        data._e = e;
        if (!this.isOpened) return;
        if (this.#apiSocket) this.#apiSocket.sendUTF(JSON.stringify(data));
        else this.#apiSocketBuffer.push(data);
    }

    end() {
        log(`Session #${this.id} destroyed`);
        this.isOpened = false;
        delete sessions[this.id];
        if (this.#apiSocket) this.#apiSocket.close(4001);
        this.#apiSocketBuffer = [];
        this.#server.close();
        this.#s2Server.close();
        Object.values(this.sockets).forEach(pair => pair[0].end());
    }
}

let apiServer = https.createServer(tlsOptions, (rq, rp) => {
    rp.writeHead(403);
    rp.end();
});
apiServer.listen((+process.env.webSocketPort));

let wsServer = new websocket.server({
    httpServer: apiServer,
    autoAcceptConnections: true
});

/**
 * @type {Object<string, Session>}
 */
let sessions = {};

wsServer.on('connect', con => {
    let closeTO = setTimeout(() => {
        con.close(4002);
    }, 5000);

    con.on('message', msg => {
        let data;
        try {
            data = JSON.parse(msg.utf8Data);
        }
        catch (_e) { log('-a') }

        if (!data || !data._e) return;
        switch (data._e) {
            case 'session.create': {
                if (data.authMethod == 'credentials') {
                    if (data.login || !(+process.env.allowAnonymous)) {
                        if (!users[data.login]) return con.close(4008, '!Unknown login');
                        if (users[data.login].password != data.password) return con.close(4008, '!Wrong password');
                    }
                }
                else return con.close(4008, '!Unknown authMethod ' + data.authMethod);

                if (Object.keys(sessions).length >= 45000) return con.close(4004);
                let port = 0;
                if (!isNaN(data.externalPort) && data.externalPort >= (+process.env.minPort) && data.externalPort <= (+process.env.maxPort) - 10000) {
                    if (Object.values(sessions).some(s => data.externalPort == s.externalPort || data.externalPort == s.externalPort + 10000)) {
                        if (data.forceExternalPort) return con.close(4003);
                    }
                    else port = data.externalPort;
                }
                if (!port) {
                    port = randomInteger((+process.env.minPort), (+process.env.maxPort) - 10000);
                    while (Object.values(sessions).some(s => port == s.externalPort || port == s.externalPort + 10000)) port = randomInteger((+process.env.minPort), (+process.env.maxPort) - 10000);
                }

                let id = makeid(3);
                while (sessions[id]) id = makeid(3);
                con.removeAllListeners();
                clearTimeout(closeTO);
                sessions[id] = new Session(id, makeid(64), parseInt(port), con, data.login || '');
                break;
            }
            case 'session.resurrect': {
                let session = sessions[data.id];
                if (!session) return con.close(4005);
                if (session.token != data.token) return con.close(4007);
                con.removeAllListeners();
                clearTimeout(closeTO);
                session.initAPISocket(con);
                break;
            }
        }
    });
});

log('Server started');

if ((+process.env.expressServerPort)) {
    let expressServer = Express();
    expressServer.get('/help', (rq, rp) => {
        rp.type('html');
        rp.sendFile(path.resolve('./html/help.html'));
    });

    expressServer.get('/session/:id', (rq, rp) => {
        let s = sessions[rq.params.id];
        rp.end(s ? JSON.stringify({
            ok: true,
            id: s.id,
            externalPort: s.externalPort,
            token: s.token.substr(0, 6) + Array(58).fill('*').join('')
        }, null, 4) : JSON.stringify({ ok: false }, null, 4));
    });

    expressServer.get('/sessions', (rq, rp) => {
        let list = {};
        for (let i in sessions) list[i] = sessions[i].externalPort;

        rp.end(JSON.stringify({
            ok: true,
            list: list
        }, null, 4));
    });

    let httpsServer = https.createServer(tlsOptions, expressServer);

    httpsServer.listen((+process.env.expressServerPort));
}