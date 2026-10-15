FROM node@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
ENV NODE_ENV=production
WORKDIR /opt/orloom-verifier
RUN echo 'd1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c  /usr/local/bin/node' | sha256sum -c - \
 && rm -f /etc/apt/sources.list.d/debian.sources \
 && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261014T000000Z bookworm main\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261014T000000Z bookworm-security main\n' > /etc/apt/sources.list \
 && timeout --signal=TERM --kill-after=10s 600s apt-get update \
 && timeout --signal=TERM --kill-after=10s 600s apt-get install -y --no-install-recommends git \
 && dpkg-query -W > /opt/orloom-verifier/debian-package-versions.txt \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
 && command -v git prlimit tar sh bash \
 && cp -a /usr/local/lib/node_modules/npm /opt/orloom-verifier/npm
COPY infra/verifier-isolation/run-check.js infra/verifier-isolation/run-repo-suite.js infra/verifier-isolation/suite-policy.js infra/verifier-isolation/stage-runner.js infra/verifier-isolation/suite-diagnostics.js infra/verifier-isolation/copy-git-askpass.js infra/verifier-isolation/emit-result.js /opt/orloom-verifier/
COPY package.json package-lock.json /opt/orloom-verifier/admission/
RUN echo 'd1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c  /usr/local/bin/node' | sha256sum -c - \
 && echo 'c7fdcfa70e2be9c2fa77f7c7812dff23729469797b5dfc8114b9d61ff20957df  /opt/orloom-verifier/admission/package.json' | sha256sum -c - \
 && echo '1c9fb3bc8b944f210492b4ae1a2750605d8495f349000464d17afcaa4f9ff1b4  /opt/orloom-verifier/admission/package-lock.json' | sha256sum -c - \
 && mkdir -p /opt/orloom-verifier/npm-config \
 && : > /opt/orloom-verifier/npm-config/user.npmrc \
 && : > /opt/orloom-verifier/npm-config/global.npmrc \
 && cd /opt/orloom-verifier/admission \
 && timeout --signal=TERM --kill-after=10s 600s env -i HOME=/tmp PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node /opt/orloom-verifier/npm/bin/npm-cli.js ci --include=dev --ignore-scripts --no-audit --no-fund --cache=/tmp/orloom-npm-cache --userconfig=/opt/orloom-verifier/npm-config/user.npmrc --globalconfig=/opt/orloom-verifier/npm-config/global.npmrc \
 && mv node_modules /opt/orloom-verifier/node_modules \
 && chmod -R a-w /opt/orloom-verifier/node_modules \
 && rm -rf /opt/orloom-verifier/admission /opt/orloom-verifier/npm-config /tmp/orloom-npm-cache \
 && chmod 0555 /usr/local/bin/node /opt/orloom-verifier/run-check.js /opt/orloom-verifier/run-repo-suite.js /opt/orloom-verifier/npm/bin/npm-cli.js /opt/orloom-verifier/stage-runner.js /opt/orloom-verifier/suite-policy.js /opt/orloom-verifier/suite-diagnostics.js /opt/orloom-verifier/copy-git-askpass.js /opt/orloom-verifier/emit-result.js
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/node", "/opt/orloom-verifier/run-check.js"]
