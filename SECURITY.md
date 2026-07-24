# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it privately using [GitHub Security Advisories](../../security/advisories/new) rather than opening a public issue.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce
- Any relevant logs, payloads, or configuration

We aim to acknowledge reports within a few days.

## Scope Notes

`mge-logs-parser` is an internal microservice with **no authentication** on its `POST /parse` endpoint (see [README.md](README.md#security)). It is intended to run on a private network behind a service that controls access. If you find a deployment of this service exposed directly to the public internet, that is expected to be a deployment/config issue rather than an application vulnerability, but we'd still like to know about it.
