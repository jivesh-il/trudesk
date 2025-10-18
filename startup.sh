#!/bin/bash

# Ensure PM2 home directory exists
if [ ! -d /usr/src/trudesk/.pm2 ]; then
    echo "Creating PM2 home directory..."
    mkdir -p /usr/src/trudesk/.pm2
fi

# Ensure logs directory exists
if [ ! -d /usr/src/trudesk/logs ]; then
    echo "Creating logs directory..."
    mkdir -p /usr/src/trudesk/logs
fi

if [ ! -d /usr/src/trudesk/public/uploads/users ]; then
    echo "Creating Directory..."
    mkdir -p /usr/src/trudesk/public/uploads/users
fi

if [ ! -f /usr/src/trudesk/public/uploads/users/defaultProfile.jpg ]; then
    echo "Coping defaultProfile.jpg"
    cp /usr/src/trudesk/public/img/defaultProfile.jpg /usr/src/trudesk/public/uploads/users/defaultProfile.jpg
fi

node /usr/src/trudesk/runner.js