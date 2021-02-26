/**
* kurento-monitor (c) 2016-2017 Mario Gasparoni Junior
*
* Freely distributed under the MIT license
*/

const config = require('config');
const console_stamp = require('console-stamp');
const kurento = require('kurento-client');
const fs = require('fs');
const file_output = config.get('file_output');
const graph_only = config.get('graph_only');

var logger = null;
var logger_file_writer = null;

if (file_output) {
  logger_file_writer = getFileWriter();
  logger = new console.Console(logger_file_writer, logger_file_writer);

  const logger_options = {
    pattern: "dd-mm HH:MM:ss",
    label: false,
    stdout: logger_file_writer
  };

  console_stamp(logger, logger_options);
}

if (!graph_only && config.get('log_prefix') !== false) {
  const console_stamp_options = {
    pattern: config.get('log_prefix') || 'dd-mm HH:MM:ss',
    label: false
  };

  console_stamp(console, console_stamp_options);
}

const spacesNum = config.get('space_width');

const info_interval = config.get('info_interval') || 2000;
const keep_monitoring = config.get('keep_monitoring');
const pipelines_only = config.get('pipelines_only');

process.env.NODE_TLS_REJECT_UNAUTHORIZED =
  config.get('kurento.reject_self_signed');

const prom = require('prom-client');

async function getStats() {
    let buf = await prom.register.metrics();
    return buf;
}

var pipelinesGauge = null;
var upGauge = null;
var lastChecked = null;
if (config.get('prometheus_port') > 0) {
  const http = require('http');
  lastChecked = new prom.Gauge({ name: 'kurento_last_scrape', help: 'Last time Kurento Exporter Replied - timestamp, in ms' });
  pipelinesGauge = new prom.Gauge({ name: 'kurento_pipelines_active', help: 'Kurento Piplines Count' });
  upGauge = new prom.Gauge({ name: 'kurento_up', help: 'Is Kurento Running' });

  const httpServer = http.createServer((request, response) => {
    lastChecked.set(Date.now());
    getStats()
      .then((stats) => {
          response.setHeader('Content-Type', 'text/plain');
          response.end(stats);
        })
      .catch((e) => {
          response.end('error');
          console.log(e);
        });
  });

  httpServer.listen(config.get('prometheus_port'), '0.0.0.0', () => {
    let b = `Server listening on ${config.get('prometheus_port')}`;
    console.log(b);
    if (file_output && logger) {
      logger.log(b);
    }
  });
}

var kurentoClient = null;

function getKurentoClient(callback) {
  var wsUri = process.argv[2] || config.get('kurento.server.uri');

  kurento(wsUri, function(err, _kurentoClient) {
    if (err) {
      console.log("Could not find media server at address " + wsUri);
      return callback(err);
    }

    callback(null, _kurentoClient);
  });
}

function getPipelinesInfo(server, callback) {
  if (!server) {
    return callback('error - failed to find server');
  }

  var _pipelines = {};

  server.getPipelines(function(error,pipelines){
    if (error) {
      return callback(error);
    }

    if (pipelines && (pipelines.length < 1)) {
      return callback(null,_pipelines);
    }

    var childsCounter = 0;
    pipelines.forEach(function(p,index,array){
      p.getChilds(function(error,elements){
        //add child elements to pipeline
        this.childs = elements;
        //append pipeline+childs to _pipelines
        _pipelines[childsCounter] = this
        childsCounter++;
        if(childsCounter == array.length) {
          //last child got, return
          return callback(null,_pipelines);
        }
      })
    })
  })
}

function output(data) {
  if (upGauge === null) {
    console.log(data);
    if (file_output && logger) {
      logger.log(data);
    }
  }
}

function getInfo(server, callback) {
  if (!server) {
    if (upGauge !== null) {
      upGauge.set(0);
    }
    return callback('error - failed to find server');
  } else if (upGauge !== null) {
    upGauge.set(1);
  }

  server.getInfo(function(error,serverInfo) {
    if (error) {
      return callback(error);
    }

    getPipelinesInfo(server, function( error, pipelinesInfo ) {
      if (error) {
        return callback(error);
      }

      var pipelinesNumber = Object.keys(pipelinesInfo).length;
      if (pipelinesGauge !== null) {
	pipelinesGauge.set(pipelinesNumber);
      }
      if (pipelines_only) {
        return callback(pipelinesNumber);
      } else {
        //add pipeline info to server info
        serverInfo.pipelinesNumber = pipelinesNumber;
        serverInfo.pipelines = pipelinesInfo;
	//if (versionText !== null) {
	//  versionText.set(serverInfo.version);
	//}
        return callback(JSON.stringify(serverInfo,null,spacesNum));
      }
    });
  })
}

function getGraph(server, callback){
  if (!server) {
    if (upGauge !== null) {
      upGauge.set(0);
    }
    return callback('error - failed to find server');
  } else if (upGauge !== null) {
    upGauge.set(1);
  }

  server.getPipelines(function (error, pipelines) {
    if (error) {
      return callback('error - failed to get pipelines');
    }

    if (pipelinesGauge !== null) {
      pipelinesGauge.set(pipelines.length);
    }
    if (pipelines.length > 0) {
      var pipeline = pipelines[0];
      pipeline.getGstreamerDot('SHOW_CAPS_DETAILS', function(error, dotGraph) {
        if (error) {
          return callback('error - failed to get graph');
        }
        return callback(dotGraph);
      });
    } else { return callback('no pipelines'); }
  });
}

function exit(code) {
  process.exit(code);
}

function getFileWriter() {
    var date = new Date();
    var year = date.getFullYear();
    var day = (date.getDate() < 10) ? '0' + date.getDate() : date.getDate() ;
    var month = (date.getMonth() < 10) ?
      '0' + (date.getMonth() + 1) : (date.getMonth() + 1);
    var hours = (date.getHours() < 10) ? '0' + date.getHours() : date.getHours();
    var minutes = (date.getMinutes() < 10) ?
      '0' + date.getMinutes() : date.getMinutes();

    var dateFormat = ''+ year + day +  month + hours + minutes;

    return fs.createWriteStream('./kurento-monitor-' +
      dateFormat + '.out');
}

function stop(error) {
  if (kurentoClient) {
    kurentoClient.close();
  }

  if (file_output && logger_file_writer) {
    logger_file_writer.end();
  }
  exit(0);
}

process.on('SIGINT', stop);

function start () {
  getKurentoClient(function(err, _kurentoClient) {
    if (err) {
      console.log('Failed load kurento client. ' + err);
      exit(1);
    }

    kurentoClient = _kurentoClient;

    _kurentoClient.getServerManager(function (error,server) {
      if (error) {
        console.log(error);
        exit(1);
      }

      var info = graph_only ? getGraph : getInfo ;
      info(server, function(data) {
        output(data);
        if (keep_monitoring) {
          setInterval(info, info_interval, server, output);
        } else {
          stop();
        }
      });
    })
  });
}

//start
start();
