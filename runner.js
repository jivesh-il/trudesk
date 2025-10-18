;(function () {
  'use strict'

  var pm2 = require('pm2')
  var path = require('path')
  var fs = require('fs')

  // Set PM2_HOME to a writable directory if not already set
  if (!process.env.PM2_HOME) {
    process.env.PM2_HOME = path.join(__dirname, '.pm2')
  }

  // Ensure PM2 home directory and all subdirectories exist and are writable
  var pm2Home = process.env.PM2_HOME
  if (!fs.existsSync(pm2Home)) {
    fs.mkdirSync(pm2Home, { recursive: true, mode: 0o755 })
  }
  
  // Create PM2 subdirectories that it needs
  var pm2Subdirs = ['logs', 'pids', 'modules']
  pm2Subdirs.forEach(function(subdir) {
    var subdirPath = path.join(pm2Home, subdir)
    if (!fs.existsSync(subdirPath)) {
      fs.mkdirSync(subdirPath, { recursive: true, mode: 0o755 })
    }
  })

  // Connect to PM2 in no-daemon mode to avoid permission issues
  pm2.connect({
    daemon: false,
    pm2_home: pm2Home
  }, function (err) {
    if (err) {
      console.error('PM2 connection error:', err)
      throw err
    }

    pm2.start(
      {
        name: 'trudesk',
        script: path.join(__dirname, '/app.js'),
        output: path.join(__dirname, '/logs/output.log'),
        error: path.join(__dirname, '/logs/output.log'),
        mergeLogs: true,
        instances: 1,
        exec_mode: 'fork'
      },
      function (err) {
        if (err) {
          console.error('PM2 start error:', err)
          throw err
        }

        console.log('Trudesk started successfully with PM2')
        
        // Keep the process alive - don't disconnect in no-daemon mode
        process.on('SIGINT', function() {
          pm2.killDaemon(function() {
            process.exit(0)
          })
        })
      }
    )
  })
})()
