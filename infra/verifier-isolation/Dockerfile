FROM ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304 AS source
FROM ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304
ENV NODE_ENV=production
WORKDIR /opt/orloom-verifier
COPY --from=source /root/.nvm/versions/node/v24.15.0/bin/node /usr/local/bin/node
COPY run-check.js /opt/orloom-verifier/run-check.js
RUN echo 'd1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c  /usr/local/bin/node' | sha256sum -c - \
 && chmod 0555 /usr/local/bin/node /opt/orloom-verifier/run-check.js
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/node", "/opt/orloom-verifier/run-check.js"]
