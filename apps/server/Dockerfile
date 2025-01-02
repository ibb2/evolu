FROM --platform=linux/amd64 node:20-alpine AS builder

# Set up working directory and environment
RUN mkdir -p /home/node/app
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH=$PATH:/home/node/.npm-global/bin 

WORKDIR /home/node/app

# Install pnpm
RUN npm i -g pnpm

# Copy entire project
COPY . /home/node/app/

# Remove unnecessary project directories
RUN rm -rf /home/node/app/apps/native \
    && rm -rf /home/node/app/apps/web \
    && rm -rf /home/node/app/pacakges/evolu-common-web \
    && rm -rf /home/node/app/pacakges/evolu-common-react \
    && rm -rf /home/node/app/pacakges/evolu-react \
    && rm -rf /home/node/app/pacakges/evolu-react-native \
    && rm -rf /home/node/app/examples/*

# Install dependencies
RUN pnpm install --no-strict-peer-dependencies

# Specific package linking steps
RUN mkdir -p /home/node/app/packages/evolu-server/node_modules/effect/ \
    && mkdir -p /home/node/app/packages/evolu-common/node_modules/effect/ \
    && mkdir -p /home/node/app/packages/evolu-common/node_modules/@effect/ \
    && cp -r /home/node/app/node_modules/effect/* /home/node/app/packages/evolu-server/node_modules/effect/ \
    && cp -r /home/node/app/node_modules/effect/* /home/node/app/packages/evolu-common/node_modules/effect/ \
    && cp -r /home/node/app/node_modules/@effect/* /home/node/app/packages/evolu-common/node_modules/@effect/ \
    && mkdir -p /home/node/app/packages/evolu-common/node_modules/@noble/ \
    && mv /home/node/app/node_modules/@noble/* /home/node/app/packages/evolu-common/node_modules/@noble/ \
    && mkdir -p /home/node/app/packages/evolu-common/node_modules/@protobuf-ts/ \
    && mv /home/node/app/node_modules/@protobuf-ts/* /home/node/app/packages/evolu-common/node_modules/@protobuf-ts/ \
    && mkdir -p /home/node/app/packages/evolu-common/node_modules/@scure/ \
    && mv /home/node/app/node_modules/@scure/* /home/node/app/packages/evolu-common/node_modules/@scure/ \
    && mkdir -p /home/node/app/packages/evolu-common/node_modules/fast-check/ \
    && mv /home/node/app/node_modules/fast-check/* /home/node/app/packages/evolu-common/node_modules/fast-check/ \
    && mkdir -p /home/node/app/packages/evolu-common/node_modules/find-my-way-ts/ \
    && mv /home/node/app/node_modules/find-my-way-ts/* /home/node/app/packages/evolu-common/node_modules/find-my-way-ts/ \
    && mkdir -p /home/node/app/packages/evolu-common/node_modules/multipasta/ \
    && mv /home/node/app/node_modules/multipasta/* /home/node/app/packages/evolu-common/node_modules/multipasta/ \
    && mkdir -p /home/node/app/packages/evolu-common/node_modules/pure-rand/ \
    && mv /home/node/app/node_modules/pure-rand/* /home/node/app/packages/evolu-common/node_modules/pure-rand/ \
    && mkdir -p /home/node/app/packages/evolu-server/node_modules/kysely/ \
    && mkdir -p /home/node/app/packages/evolu-common/node_modules/kysely/ \
    && cp -r /home/node/app/node_modules/kysely/* /home/node/app/packages/evolu-server/node_modules/kysely/ \
    && cp -r /home/node/app/node_modules/kysely/* /home/node/app/packages/evolu-common/node_modules/kysely/ \
    && mkdir -p /home/node/app/packages/evolu-server/node_modules/better-sqlite3/ \
    && mv /home/node/app/node_modules/better-sqlite3/* /home/node/app/packages/evolu-server/node_modules/better-sqlite3/ \
    && mkdir -p /home/node/app/packages/evolu-server/node_modules/express/ \
    && mv /home/node/app/node_modules/express/* /home/node/app/packages/evolu-server/node_modules/express/ \
    && mkdir -p /home/node/app/packages/evolu-server/node_modules/body-parser/ \
    && mv /home/node/app/node_modules/body-parser/* /home/node/app/packages/evolu-server/node_modules/body-parser/ \
    && mkdir -p /home/node/app/packages/evolu-server/node_modules/depd/ \
    && mv /home/node/app/node_modules/depd/* /home/node/app/packages/evolu-server/node_modules/depd/ \
    && mkdir -p /home/node/app/packages/evolu-server/node_modules/vary/ \
    && mv /home/node/app/node_modules/vary/* /home/node/app/packages/evolu-server/node_modules/vary/ \
    && mkdir -p /home/node/app/packages/evolu-server/node_modules/cors/ \
    && mv /home/node/app/node_modules/cors/* /home/node/app/packages/evolu-server/node_modules/cors/ \
    && mkdir -p /home/node/app/packages/evolu-server/node_modules/ws/ \
    && mv /home/node/app/node_modules/ws/* /home/node/app/packages/evolu-server/node_modules/ws/ \
    && mkdir -p /home/node/app/packages/evolu-server/node_modules/object-assign/ \
    && mv /home/node/app/node_modules/object-assign/* /home/node/app/packages/evolu-server/node_modules/object-assign/ \
    && mkdir -p /home/node/app/packages/evolu-server/node_modules/bindings/ \
    && mv /home/node/app/node_modules/bindings/* /home/node/app/packages/evolu-server/node_modules/bindings/ \
    && mkdir -p /home/node/app/packages/evolu-server/node_modules/prebuild-install/ \
    && mv /home/node/app/node_modules/prebuild-install/* /home/node/app/packages/evolu-server/node_modules/prebuild-install/ \
    && mkdir -p /home/node/app/packages/evolu-server/node_modules/file-uri-to-path/ \
    && mv /home/node/app/node_modules/file-uri-to-path/* /home/node/app/packages/evolu-server/node_modules/file-uri-to-path/

# Install global express
RUN npm i -g express

# Remove local express module to avoid conflicts
RUN rm -rf /home/node/app/packages/evolu-server/node_modules/express

# Copy global express to local express
RUN cp -r /home/node/.npm-global/lib/node_modules/express /home/node/app/packages/evolu-server/node_modules/

# Copy global express dependencies to local express
RUN cp -r /home/node/.npm-global/lib/node_modules/express/node_modules/* /home/node/app/packages/evolu-server/node_modules/

FROM --platform=linux/amd64 node:20-alpine

ENV PORT=4000

COPY --from=builder /home/node/app/apps/server /home/node/app/apps/server

COPY --from=builder /home/node/app/packages/evolu-server /home/node/app/packages/evolu-server

COPY --from=builder /home/node/app/packages/evolu-common /home/node/app/packages/evolu-common

WORKDIR /home/node/app/apps/server

EXPOSE $PORT

CMD [ "npm", "start" ]