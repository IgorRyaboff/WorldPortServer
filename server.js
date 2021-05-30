#!/usr/bin/env node

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
    // получить случайное число от (min-0.5) до (max+0.5)
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
     * @type {net.Server}
     */
    #server;
    /**
     * @type {net.Server}
     */
    #rpsServer;

    constructor(id, token, port, apiSocket) {
        console.log('new session yay', id, port);
        this.id = id;
        this.token = token;
        this.externalPort = parseInt(port);

        this.#server = net.createServer(socket => {
            let id = makeid(8);
            while (this.sockets[id]) id = makeid(8);
            console.log(`Incoming socket ${id} in session ${this.id}`);
            this.sockets[id] = [socket, false, []];

            socket.on('data', chunk => {
                if (!this.sockets[id]) return;
                if (this.sockets[id][1]) this.sockets[id][1].write(chunk);
                else this.sockets[id][2].push(chunk);
            });

            socket.on('error', () => { });
            socket.on('close', () => {
                if (this.sockets[id]) {
                    if (this.sockets[id][1]) this.sockets[id][1].end();
                    delete this.sockets[id];
                }
            });

            this.send('rps.create', {
                id: id
            });
        });
        this.#server.listen(this.externalPort);

        this.#rpsServer = net.createServer(socket => {
            let id;
            socket.on('data', chunk => {
                if (id && this.sockets[id]) this.sockets[id][0].write(chunk);
                else {
                    id = chunk.toString();
                    if (this.sockets[id]) {
                        this.sockets[id][1] = socket;
                        this.sockets[id][2].forEach(chunk => socket.write(chunk));
                        console.log(`RPS created for socket ${id} in session ${this.id}`);
                    }
                    else socket.end();
                }
            });

            socket.on('error', () => { });
            socket.on('close', () => {
                if (this.sockets[id]) this.sockets[id][0].end();
                delete this.sockets[id];
            });
        });
        this.#rpsServer.listen(this.externalPort + 10000);
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
        con.on('message', msg => {
            let data;
            try {
                data = JSON.parse(msg.utf8Data);
            }
            catch (_e) { }

            if (!data || !data._e) return;
            if (args.d) console.log(`${this.id}: ${data._e}`);
            switch (data._e) {
                case 'aliveCheck': {
                    if (args.d) console.log(this.id + ': aliveCheck recieved');
                    lastAliveCheck = new Date;
                    break;
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
        this.#apiSocketBuffer.forEach(m => this.send(m._e, m));
        this.#apiSocketBuffer = [];
        this.send('session.created', {
            id: this.id,
            port: this.externalPort
        });
    }

    send(e, data = {}) {
        data._e = e;
        if (!this.isOpened) return;
        if (this.#apiSocket) this.#apiSocket.sendUTF(JSON.stringify(data));
        else this.#apiSocketBuffer.push(data);
    }

    end() {
        console.log(`Session ${this.id} destroyed`);
        this.isOpened = false;
        delete sessions[this.id];
        if (this.#apiSocket) this.#apiSocket.close(4001);
        this.#apiSocketBuffer = [];
        this.#server.close();
        this.#rpsServer.close();
        Object.values(this.sockets).forEach(pair => pair[0].end());
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
                if (!isNaN(data.externalPort) && data.externalPort >= 10000 && data.externalPort <= 55535) {
                    if (Object.values(sessions).some(s => data.externalPort == s.externalPort || data.externalPort == s.externalPort + 10000)) {
                        if (data.forceExternalPort) return con.close(4003);
                    }
                    else port = data.externalPort;
                }
                if (!port) {
                    port = randomInteger(10000, 55535);
                    while (Object.values(sessions).some(s => port == s.externalPort || port == s.externalPort + 10000)) port = randomInteger(10000, 55535);
                }

                let id = makeid(3);
                while (sessions[id]) id = makeid(3);
                con.removeAllListeners();
                clearTimeout(closeTO);
                sessions[id] = new Session(id, data.token, parseInt(port), con);
                break;
            }
            case 'session.resurrect': {
                if (!data.id || !sessions[data.id]) return con.close(4005);
                con.removeAllListeners();
                clearTimeout(closeTO);
                sessions[data.id].initAPISocket(con);
                break;
            }
        }
    });
});

console.log('Server started');