# Build backend binary file
FROM golang:1.26.4-alpine3.24 AS be-builder
ARG RELEASE_BUILD
ARG BUILD_PIPELINE
ARG BUILD_UNIXTIME
ARG BUILD_DATE
ARG BUILD_COMMIT_HASH
ARG CHECK_3RD_API
ARG SKIP_TESTS
ENV RELEASE_BUILD=$RELEASE_BUILD
ENV BUILD_PIPELINE=$BUILD_PIPELINE
ENV BUILD_UNIXTIME=$BUILD_UNIXTIME
ENV BUILD_DATE=$BUILD_DATE
ENV COMMIT_HASH=$BUILD_COMMIT_HASH
ENV CHECK_3RD_API=$CHECK_3RD_API
ENV SKIP_TESTS=$SKIP_TESTS
WORKDIR /go/src/github.com/gaohongxiang/catledger
COPY . .
RUN docker/backend-build-pre-setup.sh
RUN apk add git gcc g++ libc-dev
RUN ./build.sh backend

# Build frontend files
FROM --platform=$BUILDPLATFORM node:24.18.0-alpine3.24 AS fe-builder
ARG RELEASE_BUILD
ARG BUILD_PIPELINE
ARG BUILD_UNIXTIME
ARG BUILD_DATE
ARG BUILD_COMMIT_HASH
ENV RELEASE_BUILD=$RELEASE_BUILD
ENV BUILD_PIPELINE=$BUILD_PIPELINE
ENV BUILD_UNIXTIME=$BUILD_UNIXTIME
ENV BUILD_DATE=$BUILD_DATE
ENV COMMIT_HASH=$BUILD_COMMIT_HASH
WORKDIR /go/src/github.com/gaohongxiang/catledger
COPY . .
RUN docker/frontend-build-pre-setup.sh
RUN apk add git
RUN ./build.sh frontend

# Package docker image
FROM alpine:3.24.1
LABEL maintainer="MaysWind <i@mayswind.net>"
RUN addgroup -S -g 1000 catledger && adduser -S -G catledger -u 1000 catledger
RUN apk --no-cache add tzdata
COPY docker/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
RUN mkdir -p /catledger && chown 1000:1000 /catledger \
  && mkdir -p /catledger/data && chown 1000:1000 /catledger/data \
  && mkdir -p /catledger/log && chown 1000:1000 /catledger/log \
  && mkdir -p /catledger/storage && chown 1000:1000 /catledger/storage
WORKDIR /catledger
COPY --from=be-builder --chown=1000:1000 /go/src/github.com/gaohongxiang/catledger/catledger /catledger/catledger
COPY --from=fe-builder --chown=1000:1000 /go/src/github.com/gaohongxiang/catledger/dist /catledger/public
COPY --chown=1000:1000 conf /catledger/conf
COPY --chown=1000:1000 templates /catledger/templates
COPY --chown=1000:1000 LICENSE /catledger/LICENSE
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["/docker-entrypoint.sh"]
