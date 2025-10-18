#!/bin/bash

# Ensure PM2 home directory and all subdirectories exist with proper permissions
if [ ! -d /usr/src/trudesk/.pm2 ]; then
    echo "Creating PM2 home directory and subdirectories..."
    mkdir -p /usr/src/trudesk/.pm2/logs
    mkdir -p /usr/src/trudesk/.pm2/pids
    mkdir -p /usr/src/trudesk/.pm2/modules
    chmod -R 755 /usr/src/trudesk/.pm2
fi

# Ensure PM2 directory has write permissions for file creation
chmod 755 /usr/src/trudesk/.pm2

# Create PM2 configuration files if they don't exist
if [ ! -f /usr/src/trudesk/.pm2/module_conf.json ]; then
    echo "Creating PM2 module configuration file..."
    echo '{}' > /usr/src/trudesk/.pm2/module_conf.json
    chmod 644 /usr/src/trudesk/.pm2/module_conf.json
fi

# Ensure logs directory exists with proper permissions
if [ ! -d /usr/src/trudesk/logs ]; then
    echo "Creating logs directory..."
    mkdir -p /usr/src/trudesk/logs
    chmod 755 /usr/src/trudesk/logs
fi

# Ensure public directories exist and are writable
if [ ! -d /usr/src/trudesk/public/css ]; then
    echo "Creating CSS directory..."
    mkdir -p /usr/src/trudesk/public/css
fi

if [ ! -d /usr/src/trudesk/public/js ]; then
    echo "Creating JS directory..."
    mkdir -p /usr/src/trudesk/public/js
fi

if [ ! -d /usr/src/trudesk/public/uploads/users ]; then
    echo "Creating uploads directory..."
    mkdir -p /usr/src/trudesk/public/uploads/users
fi

# Ensure CSS files are writable for SASS compilation
echo "Setting CSS file permissions..."
ls -la /usr/src/trudesk/public/css/ 2>/dev/null || echo "CSS directory not found"
chmod 666 /usr/src/trudesk/public/css/*.css 2>/dev/null || true
ls -la /usr/src/trudesk/public/css/ 2>/dev/null || echo "CSS directory not found after chmod"

if [ ! -f /usr/src/trudesk/public/uploads/users/defaultProfile.jpg ]; then
    echo "Copying defaultProfile.jpg"
    cp /usr/src/trudesk/public/img/defaultProfile.jpg /usr/src/trudesk/public/uploads/users/defaultProfile.jpg
fi

# Start Trudesk directly with Node.js (recommended for containers)
echo "Starting Trudesk with Node.js..."
node /usr/src/trudesk/app.js