FROM ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304 AS source
FROM ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304
ENV NODE_ENV=production
WORKDIR /opt/orloom-verifier
COPY --from=source /root/.nvm/versions/node/v24.15.0/bin/node /usr/local/bin/node
COPY --from=source /root/.nvm/versions/node/v24.15.0/lib/node_modules/npm /opt/orloom-verifier/npm
COPY infra/verifier-isolation/run-check.js infra/verifier-isolation/run-repo-suite.js infra/verifier-isolation/suite-policy.js infra/verifier-isolation/stage-runner.js /opt/orloom-verifier/
COPY package.json package-lock.json /opt/orloom-verifier/admission/
RUN echo 'd1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c  /usr/local/bin/node' | sha256sum -c - \
 && echo 'ce03aab4cd061600bbcf1930380861797b4b8fa7369204b701255df1551820df  /opt/orloom-verifier/admission/package.json' | sha256sum -c - \
 && echo '1c9fb3bc8b944f210492b4ae1a2750605d8495f349000464d17afcaa4f9ff1b4  /opt/orloom-verifier/admission/package-lock.json' | sha256sum -c - \
 && mkdir -p /opt/orloom-verifier/npm-config \
 && : > /opt/orloom-verifier/npm-config/user.npmrc \
 && : > /opt/orloom-verifier/npm-config/global.npmrc \
 && cd /opt/orloom-verifier/admission && env -i HOME=/tmp PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node /opt/orloom-verifier/npm/bin/npm-cli.js ci --include=dev --ignore-scripts --no-audit --no-fund --userconfig=/opt/orloom-verifier/npm-config/user.npmrc --globalconfig=/opt/orloom-verifier/npm-config/global.npmrc \
 && mv node_modules /opt/orloom-verifier/node_modules && chmod -R a-w /opt/orloom-verifier/node_modules \
 && rm -rf /opt/orloom-verifier/admission /opt/orloom-verifier/npm-config \
 && chmod 0555 /usr/local/bin/node /opt/orloom-verifier/run-check.js /opt/orloom-verifier/run-repo-suite.js /opt/orloom-verifier/npm/bin/npm-cli.js /opt/orloom-verifier/stage-runner.js /opt/orloom-verifier/suite-policy.js
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/node", "/opt/orloom-verifier/run-check.js"]
