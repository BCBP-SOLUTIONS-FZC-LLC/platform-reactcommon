# platform-interop-tests' go-probe (`http-serve`: real platform-gincommon middleware, problem+json,
# /echo, /whoami), built the way run_interop.sh builds it: from a copy whose import paths and
# require/replace lines match the module path each sibling library checkout declares (/v2 today).
# The three libraries come in as additional build contexts (compose), so no private-module token is needed.
FROM golang:1.26.10-alpine AS build
WORKDIR /src
COPY --from=gincommon . /libs/platform-gincommon
COPY --from=events . /libs/platform-events
COPY --from=pgcommon . /libs/platform-pgcommon
COPY --from=probe *.go go.mod /src/
RUN set -eu; \
    for lib in platform-events platform-gincommon platform-pgcommon; do \
      base="github.com/BCBP-SOLUTIONS-FZC-LLC/$lib"; \
      actual=$(awk '$1 == "module" { print $2; exit }' "/libs/$lib/go.mod"); \
      if [ "$actual" != "$base" ]; then \
        major=${actual##*/v}; \
        sed -i "s#\"$base/#\"$actual/#g" /src/*.go; \
        sed -i -E "s#^([[:space:]]+)$base[[:space:]]+v[^[:space:]]+#\1$actual v$major.0.0#" /src/go.mod; \
      fi; \
      sed -i -E "s#^replace $base => .*#replace $actual => /libs/$lib#" /src/go.mod; \
    done; \
    GOFLAGS=-mod=mod GOSUMDB=off GOPRIVATE='github.com/BCBP-SOLUTIONS-FZC-LLC/*' GOTOOLCHAIN=local \
      CGO_ENABLED=0 go build -o /out/go-probe .

FROM alpine:3.22
COPY --from=build /out/go-probe /usr/local/bin/go-probe
# Not root (Trivy DS-0002): the probe needs no privilege, and 8081 is not a privileged port.
USER 65534:65534
EXPOSE 8081
ENTRYPOINT ["go-probe", "http-serve", "--port", "8081"]
