const net = require('net');
function check(port) {
    return new Promise(resolve => {
        let s = net.createServer(() => { });
        s.on('error', () => resolve(false));
        s.listen(port, undefined, () => {
            s.close();
            resolve(true);
        });
    });
}
module.exports = check;