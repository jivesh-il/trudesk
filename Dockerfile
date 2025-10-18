#FROM golang:1.17-alpine AS gcsfuse
#RUN apk add --no-cache git
#ENV GOPATH /go
#RUN go install github.com/googlecloudplatform/gcsfuse@latest

FROM node:16.14-alpine AS builder

RUN mkdir -p /usr/src/trudesk
WORKDIR /usr/src/trudesk

COPY . /usr/src/trudesk

RUN apk add --no-cache --update bash make gcc g++ python3
RUN yarn plugin import workspace-tools
RUN yarn workspaces focus --all --production
RUN cp -R node_modules prod_node_modules
RUN yarn install
RUN yarn build
RUN rm -rf node_modules && mv prod_node_modules node_modules
RUN rm -rf .yarn/cache

FROM node:16.14-alpine
WORKDIR /usr/src/trudesk
RUN apk add --no-cache ca-certificates bash mongodb-tools && rm -rf /tmp/*

# Create a non-root user
RUN addgroup -g 1001 -S trudesk && \
    adduser -S trudesk -u 1001 -G trudesk

# Create PM2 home directory and logs directory with proper permissions
RUN mkdir -p /usr/src/trudesk/.pm2/logs && \
    mkdir -p /usr/src/trudesk/.pm2/pids && \
    mkdir -p /usr/src/trudesk/.pm2/modules && \
    mkdir -p /usr/src/trudesk/logs && \
    echo '{}' > /usr/src/trudesk/.pm2/module_conf.json && \
    chmod -R 755 /usr/src/trudesk/.pm2 && \
    chmod 644 /usr/src/trudesk/.pm2/module_conf.json && \
    chmod 755 /usr/src/trudesk/logs && \
    chown -R trudesk:trudesk /usr/src/trudesk

COPY --from=builder /usr/src/trudesk .

# Change ownership of all files to trudesk user first
RUN chown -R trudesk:trudesk /usr/src/trudesk

# Ensure public directory and subdirectories are writable for runtime CSS compilation
RUN mkdir -p /usr/src/trudesk/public/css && \
    mkdir -p /usr/src/trudesk/public/js && \
    mkdir -p /usr/src/trudesk/public/uploads && \
    chmod -R 755 /usr/src/trudesk/public && \
    chmod 666 /usr/src/trudesk/public/css/*.css 2>/dev/null || true && \
    chown -R trudesk:trudesk /usr/src/trudesk

# Switch to non-root user
USER trudesk

# Set PM2_HOME environment variable to use a writable directory
ENV PM2_HOME=/usr/src/trudesk/.pm2

#COPY --from=gcsfuse /go/bin/gcsfuse /usr/local/bin

EXPOSE 8118

CMD [ "/bin/bash", "/usr/src/trudesk/startup.sh" ]
