#!/usr/bin/env node

const version = require('./package.json').version;
const net = require('net');
const http = require('http');
const websocket = require('websocket');
const fs = require('fs');
const ArgsParser = require('node-args-parser');
let args = ArgsParser(process.argv);

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
     * @type {Object<string, net.Socket>}
     */
    tunnels = {};

    /**
     * @type {websocket.connection}
     */
    #apiSocket;
    #apiSocketBuffer = [];
    #apiSocketReconTO;

    /**
     * @type {net.Server}
     */
    #server;

    constructor(id, token, port, apiSocket) {
        console.log('new session yay', id, port);
        this.id = id;
        this.token = token;
        this.externalPort = parseInt(port);

        this.#server = net.createServer(s1 => {
            let id = makeid(2);
            while (this.tunnels[id]) id = makeid(2);
            console.log(`Incoming S1 #${id} in session ${this.id}`);
            this.tunnels[id] = s1;

            s1.on('data', chunk => {
                if (!this.tunnels[id]) return;
                this.sendBinary(id, chunk);
            });

            s1.on('error', () => { });
            s1.on('close', () => {
                if (this.tunnels[id]) {
                    this.send('tunnel.closed', {
                        id: id
                    });
                    delete this.tunnels[id];
                }
            });

            this.send('tunnel.created', {
                id: id
            });
        });
        this.#server.listen(this.externalPort);
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
            if (new Date - lastAliveCheck >= 20000) {
                console.log('Client did not aliveCheck last 20 seconds. Connection will be closed, session ' + this.id);
                con.close();
            }
            else this.send('aliveCheck');
        }, 10000);
        con.on('message', raw => {
            if (raw.type == 'binary') {
                let id = raw.binaryData.subarray(0, 2).toString();
                let data = raw.binaryData.slice(2);
                if (this.tunnels[id]) {
                    this.tunnels[id].write(data);
                    console.log(this.id, id, 'received binary');
                }
                else console.log('binary for unknown', this.id, id);
            }
            else {
                let msg;
                try {
                    msg = JSON.parse(raw.utf8Data);
                }
                catch (_e) { }
    
                if (!msg || !msg._e) return;
                if (args.d) console.log(`${this.id}: ${msg._e}`);
                switch (msg._e) {
                    case 'aliveCheck': {
                        if (args.d) console.log(this.id + ': aliveCheck recieved');
                        lastAliveCheck = new Date;
                        break;
                    }
                    case 'tunnel.close': {
                        if (this.tunnels[msg.id]) this.tunnels[msg.id].end();
                        break;
                    }
                }
            }
        });
        con.on('error', e => {
            console.log(`Error in apiSocket: ${e}`);
        });
        con.on('close', code => {
            this.#apiSocket = false;
            if (code == 1000) this.end();
            else this.#apiSocketReconTO = setTimeout(() => {
                this.end();
            }, 10000);
            clearInterval(aliveCheckInterval);
        });
        this.#apiSocket = con;
        this.#apiSocketBuffer.forEach(m => {
            if (Buffer.isBuffer(m)) this.sendBinary(null, m);
            else this.send(null, m);
        });
        this.#apiSocketBuffer = [];
        this.send('session.created', {
            id: this.id,
            port: this.externalPort,
            token: this.token,
            v: version
        });
    }

    send(e, data = {}) {
        if (e) data._e = e;
        if (!this.isOpened) return;
        if (this.#apiSocket) {
            this.#apiSocket.sendUTF(JSON.stringify(data));
            console.log('sent ', data._e);
        }
        else this.#apiSocketBuffer.push(data);
    }

    sendBinary(tunnelID, data) {
        if (!this.isOpened) return;

        if (tunnelID) data = Buffer.from([...[...tunnelID].map(x => x.charCodeAt(0)), ...data]);
        if (this.#apiSocket) {
            this.#apiSocket.sendBytes(data);
            console.log(this.id, tunnelID || data.subarray(0, 2).toString(), 'sent binary');
            //console.assert([...data.subarray(0, 2).toString()].every(x => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.indexOf(x) == -1), 'Invalid tunnel id ' + data.subarray(0, 2).toString());
        }
        else this.#apiSocketBuffer.push(data);

    }

    end() {
        console.log(`Session ${this.id} destroyed`);
        this.isOpened = false;
        delete sessions[this.id];
        if (this.#apiSocket) this.#apiSocket.close(4001);
        this.#apiSocketBuffer = [];
        this.#server.close();
        Object.values(this.tunnels).forEach(tun => tun.end());
    }
}

let apiServer = http.createServer((rq, rp) => {
    rp.writeHead(403);
    rp.end();
});
apiServer.listen(100);

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
        catch (_e) { console.log('-a') }

        if (!data || !data._e) return;
        switch (data._e) {
            case 'session.create': {
                if (Object.keys(sessions).length >= 45000) return con.close(4004);
                let port = 0;
                if (!isNaN(data.externalPort) && data.externalPort >= 10000 && data.externalPort <= 65535) {
                    if (Object.values(sessions).some(s => data.externalPort == s.externalPort)) {
                        if (data.forceExternalPort) return con.close(4003);
                    }
                    else port = data.externalPort;
                }
                if (!port) {
                    port = randomInteger(10000, 65535);
                    while (Object.values(sessions).some(s => port == s.externalPort)) port = randomInteger(10000, 65535);
                }

                let id = makeid(3);
                while (sessions[id]) id = makeid(3);
                con.removeAllListeners();
                clearTimeout(closeTO);
                sessions[id] = new Session(id, makeid(8), parseInt(port), con);
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

console.log('Server started');