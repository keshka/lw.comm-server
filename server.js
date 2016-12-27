"use strict";
/*

    AUTHOR:  Claudio Prezzi github.com/cprezzi

    THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
    WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
    MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
    ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
    WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
    ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
    OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.

*/
var config = require('./config');
var serialport = require("serialport");
var SerialPort = serialport;
var websockets = require('socket.io');
var app = require('http').createServer(handler);
var io = websockets.listen(app);
var telnet = require('telnet-client');
var WebSocket = require('ws');
var fs = require('fs');
var nstatic = require('node-static');
var EventEmitter = require('events').EventEmitter;
var url = require('url');
var qs = require('querystring');
var util = require('util');
var http = require('http');
var chalk = require('chalk');
var request = require('request'); // proxy for remote webcams

var connections = [];
var portType; 
var port, isConnected, connectedTo;
var telnetConnection, telnetConnected; 
var espSocket, espConnected, espIP, espBuffer;
var statusLoop, queueCounter;
var gcodeQueue; gcodeQueue = [];
var lastSent = "", paused = false, blocked = false;

var firmware, fVersion = 0;
var feedOverride = 100;
var spindleOverride = 100;
var laserTestOn = false;

var GRBL_RX_BUFFER_SIZE = 128; // 128 characters
var grblBufferSize = [];

var tinygBufferSize = 4; // space for 4 lines of gcode left
var jsObject;


require('dns').lookup(require('os').hostname(), function (err, add, fam) {
    console.log(chalk.green(' '));
    console.log(chalk.green('***************************************************************'));
    console.log(chalk.white('                 ---- LaserWeb Comm Server ----                '));
    console.log(chalk.green('***************************************************************'));
    console.log(chalk.white('  Use '), chalk.yellow(' http://' + add + ':' + config.webPort + ' to connect this server.'));
    console.log(chalk.green('***************************************************************'));
    console.log(chalk.green(' '));
    console.log(chalk.green(' '));
    console.log(chalk.red('* Updates: '));
    console.log(chalk.green('  Remember to check the commit log on'));
    console.log(chalk.green(' '), chalk.yellow('https://github.com/LaserWeb/lw.comm-server/commits/master'));
    console.log(chalk.green('  regularly, to know about updates and fixes, and then when ready'));
    console.log(chalk.green('  update accordingly by running'), chalk.cyan("git pull"));
    console.log(chalk.green(' '));
    console.log(chalk.red('* Support: '));
    console.log(chalk.green('  If you need help / support, come over to '));
    console.log(chalk.green(' '), chalk.yellow('https://plus.google.com/communities/115879488566665599508'));
});


// Init webserver
app.listen(config.webPort);
var webServer = new nstatic.Server('./app');

function handler(req, res) {
    var queryData = url.parse(req.url, true).query;
    if (queryData.url) {
        if (queryData.url !== "") {
            request({
                url: queryData.url, // proxy for remote webcams
                callback: (err, res, body) => {
                    if (err) {
                        // console.log(err)
                        console.error(chalk.red('ERROR:'), chalk.yellow(' Remote Webcam Proxy error: '), chalk.white("\"" + queryData.url + "\""), chalk.yellow(' is not a valid URL: '));
                    }
                }
            }).on('error', function (e) {
                res.end(e);
            }).pipe(res);
        }
    } else {
        webServer.serve(req, res, function (err, result) {
            if (err) {
                console.error(chalk.red('ERROR:'), chalk.yellow(' webServer error:' + req.url + ' : '), err.message);
            }
        });
    }
}


// WebSocket connection from frontend
io.sockets.on('connection', function (appSocket) {

    // save new connection
    connections.push(appSocket);

    // send available ports
    serialport.list(function (err, ports) {
        appSocket.emit("ports", ports);
    });

    appSocket.on('firstLoad', function (data) {
        appSocket.emit('config', config);
        if (isConnected) {
            appSocket.emit("activePorts", port.path + ',' + port.options.baudRate);
            appSocket.emit("connectStatus", 'opened:' + port.path);
        }
    });

    appSocket.on('connectTo', function (data) { // If a user picks a port to connect to, open a Node SerialPort Instance to it
        data = data.split(',');
        console.log(chalk.yellow('WARN:'), chalk.blue('Connecting to ' + data));
        if (!isConnected) {
            portType = data[0];
            switch (portType) {
                case 'usb':
                    port = new SerialPort(data[1], {
                        parser: serialport.parsers.readline("\n"),
                        baudrate: parseInt(data[2])
                    });
                    io.sockets.emit("connectStatus", 'opening:' + port.path);

                    // Serial port events -----------------------------------------------
                    port.on('open', function () {
                        io.sockets.emit("activePorts", port.path + ',' + port.options.baudRate);
                        io.sockets.emit("connectStatus", 'opened:' + port.path);
                        // port.write("?");         // Lets check if its Grbl? 
                        // port.write("version\n"); // Lets check if its Smoothieware?
                        // port.write("$fb\n"); // Lets check if its TinyG
                        // port.write("M115\n");    // Lets check if its Marlin?
                        console.log('Connected to ' + port.path + ' at ' + port.options.baudRate);
                        isConnected = true;
                        connectedTo = port.path;

                        // Start interval for qCount messages to appSocket clients
                        queueCounter = setInterval(function () {
                            io.sockets.emit('qCount', gcodeQueue.length);
                        }, 500);
                    });

                    port.on('close', function () { // open errors will be emitted as an error event
                        clearInterval(queueCounter);
                        clearInterval(statusLoop);
                        isConnected = false;
                        connectedTo = false;
                        paused = false;
                        blocked = false;
                        io.sockets.emit("connectStatus", 'Connect');
                        console.log(chalk.yellow('WARN:'), chalk.blue('Port closed ' + port.path));
                    });

                    port.on('error', function (err) { // open errors will be emitted as an error event
                        console.log('Error: ', err.message);
                        io.sockets.emit("data", err.message);
                    });

                    port.on("data", function (data) {
                        console.log('Recv: ' + data);
                        if (data.indexOf('{') === 0) { // TinyG response
                            jsObject = JSON.parse(data);
                            if (jsObject.hasOwnProperty('r')) {
                                var footer = jsObject.f || (jsObject.r && jsObject.r.f);
                                if (footer !== undefined) {
                                    if (footer[1] == 108) {
                                        console.log(
                                            "Response",
                                            util.format("TinyG reported an syntax error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]),
                                            jsObject
                                        );
                                    } else if (footer[1] == 20) {
                                        console.log(
                                            "Response",
                                            util.format("TinyG reported an internal error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]),
                                            jsObject
                                        );
                                    } else if (footer[1] == 202) {
                                        console.log(
                                            "Response",
                                            util.format("TinyG reported an TOO SHORT MOVE on line %d", jsObject.r.n),
                                            jsObject
                                        );
                                    } else if (footer[1] == 204) {
                                        console.log(
                                            "InAlarm",
                                            util.format("TinyG reported COMMAND REJECTED BY ALARM '%s'", part),
                                            jsObject
                                        );
                                    } else if (footer[1] != 0) {
                                        console.log(
                                            "Response",
                                            util.format("TinyG reported an error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]),
                                            jsObject
                                        );
                                    }

                                    // Remove the object so it doesn't get parsed anymore
                                    // delete jsObject.f;
                                    // if (jsObject.r) {
                                    //   delete jsObject.r.f;
                                    // }
                                }

                                console.log("response", jsObject.r, footer);

                                jsObject = jsObject.r;

                                tinygBufferSize++;
                                blocked = false;
                                send1Q();
                            }

                            if (jsObject.hasOwnProperty('er')) {
                                console.log("errorReport", jsObject.er);
                            } else if (jsObject.hasOwnProperty('sr')) {
                                console.log("statusChanged", jsObject.sr);
                            } else if (jsObject.hasOwnProperty('gc')) {
                                console.log("gcodeReceived", jsObject.gc);
                            }

                            if (jsObject.hasOwnProperty('rx')) {
                                console.log("rxReceived", jsObject.rx);
                            }
                            if (jsObject.hasOwnProperty('fb')) { // Check if it's TinyG
                                firmware = 'tinyg';
                                fVersion = jsObject.fb;
                                console.log('TinyG detected (' + fVersion + ')');
                                // Start intervall for status queries
                                statusLoop = setInterval(function () {
                                    if (isConnected) {
                                        port.write('{"sr":null}');
                                    }
                                }, 250);
                            }
                        }
                        if (data.indexOf('Grbl') === 0) { // Check if it's Grbl
                            firmware = 'grbl';
                            fVersion = data.substr(5, 4); // get version
                            console.log('GRBL detected (' + fVersion + ')');
                            // Start intervall for status queries
                            statusLoop = setInterval(function () {
                                if (isConnected) {
                                    port.write('?');
                                }
                            }, 250);
                        }
                        if (data.indexOf('LPC176') >= 0) { // LPC1768 or LPC1769 should be Smoothie
                            firmware = 'smoothie';
                            var startPos = data.search(/Version:/i) + 9;
                            fVersion = data.substr(startPos).split(/,/, 1);
                            console.log('Smoothieware detected (' + fVersion + ')');
                            // Start intervall for status queries
                            statusLoop = setInterval(function () {
                                if (isConnected) {
                                    port.write('?');
                                }
                            }, 250);
                        }
                        if (data.indexOf("ok") === 0) { // Got an OK so we are clear to send
                            blocked = false;
                            if (firmware === 'grbl') {
                                grblBufferSize.shift();
                            }
                            send1Q();
                        }
                        if (data.indexOf("error") === 0) {
                            if (firmware === 'grbl') {
                                grblBufferSize.shift();
                            }
                        }
                        io.sockets.emit("data", data);
                    });
                    break;
                
                case 'telnet':
                    telnetConnection = new telnet();
                    var params = {
                      host: data[1],
                      port: 23,
                      shellPrompt: '> ',
                      //timeout: 1500,
                      // removeEcho: 4 
                    };
                    telnetConnection.connect(params);
                    io.sockets.emit("connectStatus", 'opening:' + data[1]);

                    // Telnet connection events -----------------------------------------------
                    telnetConnection.on('ready', function (prompt) {
                        telnetConnection.exec('version', function (err, response) {
                            console.log('Telnet:', response);
                        });
                    });

                    telnetConnection.on('timeout', function () {
                        console.log(chalk.yellow('WARN:'), 'Telnet socket timeout!')
                        telnetConnection.end();
                    });

                    telnetConnection.on('close', function () {
                        console.log(chalk.yellow('WARN:'), 'Telnet connection closed');
                    });         
                    break;
                    
                case 'esp8266':
                    espIP = data[1];
                    espSocket = new WebSocket('ws://'+espIP+'/'); // connect to ESP websocket
                    io.sockets.emit("connectStatus", 'opening:' + espIP);
                    
                    // ESP socket evnets -----------------------------------------------        
                    espSocket.on('open', function (e) {
                        io.sockets.emit("connectStatus", 'opened:' + espIP);
                        console.log(chalk.yellow('WARN:'), chalk.blue('ESP connected @ ' + espIP));
                        espConnected = true;
                        espSocket.send('version\n');
                        statusLoop = setInterval(function () {
                            if (espConnected) {
                                espSocket.send('?');
                            } else {
                                clearInterval(statusLoop);
                                console.log(chalk.yellow('WARN:'), 'Unable to send gcode (not connected to ESP): ' + e);
                            }
                        }, 250);
                    });

                    espSocket.on('close', function (e) {
                        espConnected = false;
                        espIP = false;
                        paused = false;
                        blocked = false;
                        io.sockets.emit("connectStatus", 'Connect');
                        console.log(chalk.yellow('WARN:'), chalk.blue('ESP connection closed'));
                    });

                    espSocket.on('error', function (e) {
                        io.sockets.emit("error", e.message);
                        console.log(chalk.red('ERROR:'), 'ESP error: ' + e.message);
                    });

                    espSocket.on('message', function (e) {
                        //console.log('ESP:', e);
                        //io.sockets.emit("data", data);
//                        var data = "";
//                        var i;
//                        if (e.data instanceof ArrayBuffer) {
//                            var bytes = new Uint8Array(e.data);
//                            for (i = 0; i < bytes.length; i++) {
//                                data += String.fromCharCode(bytes[i]);
//                            }
//                        } else {
//                            data = e.data;
//                        }
//
//                        espBuffer += data;
//                        var split = espBuffer.split()"\n");
//                        espBuffer = split.pop(); //last not fin data back to buffer
//                        // console.log(split)
//                        for (i = 0; i < split.length; i++) {
//                            var response = split[i];
//                            console.log('ESP:', response);
//                            if (response.indexOf('Grbl') === 0) { // Check if it's Grbl
//                                firmware = 'grbl';
//                                fVersion = response.substr(5, 4); // get version
//                                console.log('GRBL detected (' + fVersion + ')');
//                                // Start intervall for status queries
//                                statusLoop = setInterval(function () {
//                                    if (isConnected) {
//                                        port.write('?');
//                                    }
//                                }, 250);
//                            }
//                            if (response.indexOf('LPC176') >= 0) { // LPC1768 or LPC1769 should be Smoothie
//                                firmware = 'smoothie';
//                                var startPos = response.search(/Version:/i) + 9;
//                                fVersion = response.substr(startPos).split(/,/, 1);
//                                console.log('Smoothieware detected (' + fVersion + ')');
//                                // Start intervall for status queries
//                                statusLoop = setInterval(function () {
//                                    if (isConnected) {
//                                        port.write('?');
//                                    }
//                                }, 250);
//                            }
//                            if (response.indexOf("ok") === 0) { // Got an OK so we are clear to send
//                                blocked = false;
//                                if (firmware === 'grbl') {
//                                    grblBufferSize.shift();
//                                }
//                                send1Q();
//                            }
//                            if (response.indexOf("error") === 0) {
//                                if (firmware === 'grbl') {
//                                    grblBufferSize.shift();
//                                }
//                            }
//                            io.sockets.emit("data", response);
//                        }
                    });
                    break;
            }
        } else {
            //io.sockets.emit("connectStatus", 'resume:' + port.path);
            io.sockets.emit("connectStatus", 'opened:' + port.path);

            // port.write(String.fromCharCode(0x18));   // Lets check if its Grbl?
            // port.write("version\n");                 // Lets check if its Smoothieware?
            // port.write("$fb\n");                     // Lets check if its TinyG
            // port.write("M115\n");                    // Lets check if its Marlin?
        }
    });

    appSocket.on('runJob', function (data) {
        if (isConnected) {
            data = data.split('\n');
            for (var i = 0; i < data.length; i++) {
                var line = data[i].split(';'); // Remove everything after ; = comment
                var tosend = line[0];
                if (tosend.length > 0) {
                    addQ(tosend);
                }
            }
            if (i > 0) {
                io.sockets.emit("running", gcodeQueue.length);
            }
            send1Q();
        } else {
            io.sockets.emit("connectStatus", 'closed');
            console.log(chalk.yellow('WARN:'), chalk.blue('Port closed ' + port.path));
        }
    });

    appSocket.on('serialSend', function (data) {
        if (isConnected) {
            data = data.split('\n');
            for (var i = 0; i < data.length; i++) {
                var line = data[i].split(';'); // Remove everything after ; = comment
                var tosend = line[0];
                if (tosend.length > 0) {
                    addQ(tosend);
                    send1Q();
                }
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            console.log(chalk.yellow('WARN:'), chalk.blue('Port closed ' + port.path));
        }
    });

    appSocket.on('feedOverride', function (data) {
        if (isConnected) {
            switch (firmware) {
                case 'grbl':
                    var code;
                    switch (data) {
                        case 0:
                            code = 144; // set to 100%
                            data = '100';
                            break;
                        case 10:
                            code = 145; // +10%
                            data = '+' + data;
                            break;
                        case -10:
                            code = 146; // -10%
                            break;
                        case 1:
                            code = 147; // +1%
                            data = '+' + data;
                            break;
                        case -1:
                            code = 148; // -1%
                            break;
                    }
                    if (code) {
                        //jumpQ(String.fromCharCode(parseInt(code)));
                        port.write(String.fromCharCode(parseInt(code)));
                        console.log(chalk.red('Feed Override ' + data + '%'));
                    }
                    break;
                case 'smoothie':
                    if (data === 0) {
                        feedOverride = 100;
                    } else {
                        if ((feedOverride + data <= 200) && (feedOverride + data >= 10)) {
                            // valid range is 10..200, else ignore!
                            feedOverride += data;
                        }
                    }
                    jumpQ('M220S' + feedOverride);
                    io.sockets.emit('feedOverride', feedOverride);
                    console.log(chalk.red('Feed Override ' + feedOverride.toString() + '%'));
                    send1Q();
                    break;
                case 'tinyg':
                    break;
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            console.log(chalk.yellow('WARN:'), chalk.blue('Port closed ' + port.path));
        }
    });

    appSocket.on('spindleOverride', function (data) {
        if (isConnected) {
            switch (firmware) {
                case 'grbl':
                    var code;
                    switch (data) {
                        case 0:
                            code = 153; // set to 100%
                            data = '100';
                            break;
                        case 10:
                            code = 154; // +10%
                            data = '+' + data;
                            break;
                        case -10:
                            code = 155; // -10%
                            break;
                        case 1:
                            code = 156; // +1%
                            data = '+' + data;
                            break;
                        case -1:
                            code = 157; // -1%
                            break;
                    }
                    if (code) {
                        //jumpQ(String.fromCharCode(parseInt(code)));
                        port.write(String.fromCharCode(parseInt(code)));
                        console.log(chalk.red('Spindle (Laser) Override ' + data + '%'));
                    }
                    break;
                case 'smoothie':
                    if (data === 0) {
                        spindleOverride = 100;
                    } else {
                        if ((spindleOverride + data <= 200) && (spindleOverride + data >= 0)) {
                            // valid range is 0..200, else ignore!
                            spindleOverride += data;
                        }
                    }
                    jumpQ('M221S' + spindleOverride);
                    io.sockets.emit('spindleOverride', spindleOverride);
                    console.log(chalk.red('Spindle (Laser) Override ' + spindleOverride.toString() + '%'));
                    send1Q();
                    break;
                case 'tinyg':
                    break;
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            console.log(chalk.yellow('WARN:'), chalk.blue('Port closed ' + port.path));
        }
    });

    appSocket.on('laserTest', function (data) { // Laser Test Fire
        if (isConnected) {
            data = data.split(',');
            var power = parseFloat(data[0]);
            var duration = parseInt(data[1]);
            console.log('laserTest: ', 'Power ' + power + ', Duration ' + duration);
            if (power > 0) {
                if (!laserTestOn) {
                    if (duration >= 0) {
                        switch (firmware) {
                            case 'grbl':
                                addQ('G1F1');
                                addQ('M3S' + power);
                                laserTestOn = true;
                                appSocket.emit('laserTest', power);
                                if (duration > 0) {
                                    addQ('G4 P' + duration / 1000);
                                    addQ('M5S0');
                                    laserTestOn = false;
                                    //appSocket.emit('laserTest', 0); //-> Grbl get it with status report
                                }
                                send1Q();
                                break;
                            case 'smoothie':
                                port.write('fire ' + power);
                                console.log('Fire ' + power);
                                laserTestOn = true;
                                appSocket.emit('laserTest', power);
                                if (duration > 0) {
                                    port.write('G4 P' + duration);
                                    console.log('G4 P' + duration);
                                    port.write('fire Off');
                                    console.log('Fire Off');
                                    laserTestOn = false;
                                    appSocket.emit('laserTest', 0);
                                }
                                break;
                            case 'tinyg':
                                addQ('M3S' + power);
                                laserTestOn = true;
                                appSocket.emit('laserTest', power);
                                if (duration > 0) {
                                    addQ('G4 P' + duration / 1000);
                                    addQ('M5S0');
                                    laserTestOn = false;
                                    appSocket.emit('laserTest', 0);
                                }
                                send1Q();
                                break;
                        }
                    }
                } else {
                    switch (firmware) {
                        case 'grbl':
                            addQ('M5S0');
                            send1Q();
                            break;
                        case 'smoothie':
                            port.write('fire Off');
                            console.log('Fire Off');
                            break;
                        case 'tinyg':
                            addQ('M5S0');
                            send1Q();
                            break;
                    }
                    laserTestOn = false;
                    appSocket.emit('laserTest', 0);
                }
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            console.log(chalk.yellow('WARN:'), chalk.blue('Port closed ' + port.path));
        }
    });

    appSocket.on('pause', function (data) {
        if (isConnected) {
            paused = true;
            console.log(chalk.red('PAUSE'));
            switch (firmware) {
                case 'grbl':
                    port.write('!'); // Send hold command
                    if (fVersion === '1.1d') {
                        port.write(String.fromCharCode(0x9E)); // Stop Spindle/Laser
                    }
                    break;
                case 'smoothie':
                    port.write("M600\n"); // Laser will be turned off by smoothie (in default config!)
                    break;
                case 'tinyg':
                    port.write('!'); // Send hold command
                    break;
            }
            io.sockets.emit("connectStatus", 'paused:' + port.path);
        } else {
            io.sockets.emit("connectStatus", 'closed');
            console.log(chalk.yellow('WARN:'), chalk.blue('Port closed ' + port.path));
        }
    });

    appSocket.on('unpause', function (data) {
        if (isConnected) {
            console.log(chalk.red('UNPAUSE'));
            io.sockets.emit("connectStatus", 'unpaused:' + port.path);
            switch (firmware) {
                case 'grbl':
                    port.write('~'); // Send resume command
                    break;
                case 'smoothie':
                    port.write("M601\n");
                    break;
                case 'tinyg':
                    port.write('~'); // Send resume command
                    break;
            }
            paused = false;
            send1Q(); // restart queue
        } else {
            io.sockets.emit("connectStatus", 'closed');
            console.log(chalk.yellow('WARN:'), chalk.blue('Port closed ' + port.path));
        }
    });

    appSocket.on('stop', function (data) {
        if (isConnected) {
            paused = true;
            console.log(chalk.red('STOP'));
            switch (firmware) {
                case 'grbl':
                    port.write('!'); // hold
                    if (fVersion === '1.1d') {
                        port.write(String.fromCharCode(0x9E)); // Stop Spindle/Laser
                    }
                    gcodeQueue.length = 0; // dump the queye
                    grblBufferSize.length = 0; // dump bufferSizes
                    blocked = false;
                    paused = false;
                    port.write(String.fromCharCode(0x18)); // ctrl-x
                    break;
                case 'smoothie':
                    //port.write('!');              // hold
                    paused = true;
                    port.write(String.fromCharCode(0x18)); // ctrl-x
                    gcodeQueue.length = 0; // dump the queye
                    grblBufferSize.length = 0; // dump bufferSizes
                    blocked = false;
                    paused = false;
                    break;
                case 'tinyg':
                    port.write('!'); // hold
                    port.write('%'); // dump TinyG queue
                    gcodeQueue.length = 0; // dump LW queue
                    grblBufferSize.length = 0; // dump bufferSizes
                    tinygBufferSize = 4;
                    blocked = false;
                    paused = false;
                    break;
            }
            laserTestOn = false;
            io.sockets.emit("connectStatus", 'stopped:' + port.path);
        } else {
            io.sockets.emit("connectStatus", 'closed');
            console.log(chalk.yellow('WARN:'), chalk.blue('Port closed ' + port.path));
        }
    });

    appSocket.on('clearAlarm', function (data) { // Laser Test Fire
        if (isConnected) {
            console.log('Clearing Queue: Method ' + data);
            switch (data) {
                case '1':
                    console.log('Clearing Lockout');
                    switch (firmware) {
                        case 'grbl':
                            port.write("$X\n");
                            break;
                        case 'smoothie':
                            port.write("$X\n");
                            break;
                        case 'tinyg':
                            port.write('$X/n'); // resume
                            break;
                    }
                    console.log('Resuming Queue Lockout');
                    break;
                case '2':
                    console.log('Emptying Queue');
                    gcodeQueue.length = 0; // dump the queye
                    grblBufferSize.length = 0; // dump bufferSizes
                    console.log('Clearing Lockout');
                    switch (firmware) {
                        case 'grbl':
                            port.write("$X\n");
                            break;
                        case 'smoothie':
                            port.write("$X\n"); //M999
                            break;
                        case 'tinyg':
                            port.write('%'); // flush tinyg quere
                            tinygBufferSize = 4;
                            port.write('~'); // resume
                            break;
                    }
                    break;
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            console.log(chalk.yellow('WARN:'), chalk.blue('Port closed ' + port.path));
        }
    });


    appSocket.on('getFirmware', function (data) { // Deliver Firmware to Web-Client
        appSocket.emit("firmware", firmware);
    });

    appSocket.on('refreshPorts', function (data) { // Refresh serial port list
        console.log(chalk.yellow('WARN:'), chalk.blue('Requesting Ports Refresh '));
        serialport.list(function (err, ports) {
            appSocket.emit("ports", ports);
        });
    });

    appSocket.on('areWeLive', function (data) { // Report active serial port to web-client
        if (isConnected) {
            appSocket.emit("activePorts", port.path + ',' + port.options.baudRate);
        }
    });
    
    appSocket.on('closePort', function (data) { // Close machine port and dump queue
        if (isConnected) {
            console.log(chalk.yellow('WARN:'), chalk.blue('Closing Port ' + port.path));
            io.sockets.emit("connectStatus", 'closing:' + port.path);
            port.write(String.fromCharCode(0x18)); // ctrl-x
            gcodeQueue.length = 0; // dump the queye
            grblBufferSize.length = 0; // dump bufferSizes
            tinygBufferSize = 4; // reset tinygBufferSize
            clearInterval(queueCounter);
            clearInterval(statusLoop);
            port.close();
        } else {
            io.sockets.emit("connectStatus", 'closed');
            console.log(chalk.yellow('WARN:'), chalk.blue('Port closed ' + port.path));
        }
    });

    appSocket.on('closeEsp', function (data) { // Close socket connection to ESP
        if (espConnected) {
            console.log(chalk.yellow('WARN:'), chalk.blue('Closing ESP @ ' + espIP));
            io.sockets.emit("connectStatus", 'closing:' + espIP);
            espSocket.send(String.fromCharCode(0x18)); // ctrl-x
            gcodeQueue.length = 0; // dump the queye
            grblBufferSize.length = 0; // dump bufferSizes
            tinygBufferSize = 4; // reset tinygBufferSize
            clearInterval(queueCounter);
            clearInterval(statusLoop);
            espSocket.close();
        } else {
            io.sockets.emit("connectStatus", 'Connect');
            console.log(chalk.yellow('WARN:'), chalk.blue('ESP connection closed'));
        }
    });

    appSocket.on('disconnect', function () { // Deliver Firmware to Web-Client
        console.log(chalk.yellow('App disconnectd!'));
    });    

}); // End appSocket


// Queue
function addQ(gcode) {
    gcodeQueue.push(gcode);
}

function jumpQ(gcode) {
    gcodeQueue.unshift(gcode);
}

function grblBufferSpace() {
    var total = 0;
    for (var i = 0, n = grblBufferSize.length; i < n; ++i) {
        total += grblBufferSize[i];
    }
    return GRBL_RX_BUFFER_SIZE - total;
}

function send1Q() {
    if (isConnected) {
        switch (firmware) {
            case 'grbl':
                while (gcodeQueue.length > 0 && !blocked && !paused) {
                    var gcode = gcodeQueue.shift();
                    gcode = gcode.replace(/\s+/g, '');
                    var spaceLeft = grblBufferSpace();
                    var gcodeLen = gcode.length;
                    //console.log('BufferSpace: ' + spaceLeft + ' gcodeLen: ' + gcodeLen);
                    if (gcodeLen <= spaceLeft) {
                        console.log('Sent: ' + gcode + ' Q: ' + gcodeQueue.length);
                        grblBufferSize.push(gcodeLen);
                        lastSent = gcode;
                        port.write(gcode + '\n');
                    } else {
                        gcodeQueue.unshift(gcode);
                        blocked = true;
                    }
                }
                break;
            case 'smoothie':
                if (gcodeQueue.length > 0 && !blocked && !paused) {
                    var gcode = gcodeQueue.shift();
                    // Optimise gcode by stripping spaces - saves a few bytes of serial bandwidth, and formatting commands vs gcode to upper and lowercase as needed
                    gcode = gcode.replace(/\s+/g, '');
                    console.log('Sent: ' + gcode + ' Q: ' + gcodeQueue.length);
                    lastSent = gcode;
                    port.write(gcode + '\n');
                    blocked = true;
                }
                break;
            case 'tinyg':
                while (tinygBufferSize > 0 && gcodeQueue.length > 0 && !blocked && !paused) {
                    var gcode = gcodeQueue.shift();
                    // Optimise gcode by stripping spaces - saves a few bytes of serial bandwidth, and formatting commands vs gcode to upper and lowercase as needed
                    gcode = gcode.replace(/\s+/g, '');
                    console.log('Sent: ' + gcode + ' Q: ' + gcodeQueue.length);
                    lastSent = gcode;
                    port.write(gcode + '\n');
                    tinygBufferSize--;
                }
                break;
        }
    }
}