#!/usr/bin/env python3
"""Generate a Mihomo candidate with proxy DNS and optional KIX routing repairs.

This deliberately handles a single top-level, block-style ``dns`` mapping,
not arbitrary YAML. Unsupported or ambiguous input is rejected. It does not
reload Mihomo or modify the input file or system DNS configuration.
"""

import argparse
import ipaddress
import os
from pathlib import Path
import re
import sys
import tempfile


DNS_KEY = re.compile(r"^(?:dns|'dns'|\"dns\")[ \t]*:")
DNS_HEADER = re.compile(r"^(?:dns|'dns'|\"dns\")[ \t]*:[ \t]*(?:#.*)?$")


def stabilize_routing(text):
    """Patch the known ChinaProxy layout; reject ambiguous input before writing."""
    newline = "\r\n" if "\r\n" in text else "\n"
    lines = text.splitlines(keepends=True)

    def section(name):
        starts = [i for i, line in enumerate(lines) if re.fullmatch(name + r":[ \t]*(?:#.*)?", line.rstrip("\r\n"))]
        if len(starts) != 1:
            raise ValueError("Expected one block-style {} section".format(name))
        start = starts[0]
        end = start + 1
        while end < len(lines):
            line = lines[end]
            if line.strip() and not line.startswith((" ", "\t", "#")):
                break
            end += 1
        return start, end

    start, end = section("proxy-groups")
    for name, settings in [
        ("KIX", {"interval": "60", "lazy": "false", "max-failed-times": "5", "expected-status": "401"}),
        ("AUTO", {"timeout": "5000", "max-failed-times": "5"}),
    ]:
        starts = [i for i in range(start + 1, end)
                  if re.fullmatch(r"  - name: [\"']?" + name + r"[\"']?[ \t]*(?:#.*)?", lines[i].rstrip("\r\n"))]
        if len(starts) != 1:
            raise ValueError("Expected one {} proxy group".format(name))
        first = starts[0]
        last = next((i for i in range(first + 1, end) if lines[i].startswith("  - ")), end)
        if not any(re.fullmatch(r"    type: fallback[ \t]*(?:#.*)?", line.rstrip("\r\n")) for line in lines[first:last]):
            raise ValueError("{} must be a fallback group".format(name))
        for key, value in settings.items():
            positions = [i for i in range(first + 1, last) if re.match(r"    " + key + r":", lines[i])]
            if len(positions) != 1:
                raise ValueError("Expected one {}.{} setting".format(name, key))
            lines[positions[0]] = "    {}: {}{}".format(key, value, newline)
        if name == "KIX":
            # This group must not acquire a direct escape route for OpenAI.
            members = [line.strip()[2:] for line in lines[first:last] if re.match(r"      - ", line)]
            if not members or any(not re.fullmatch(r"KIX-\d+", member) for member in members):
                raise ValueError("KIX must contain only the corporate KIX nodes")

    start, end = section("rules")
    # Replace our own block, so DNS transitions and repeated installation are
    # byte-idempotent. The company's login and internal routes remain intact.
    begin = "  # BEGIN codex-proxy-guard"
    finish = "  # END codex-proxy-guard"
    positions = [i for i in range(start + 1, end) if lines[i].rstrip("\r\n") in (begin, finish)]
    if positions:
        if len(positions) != 2 or lines[positions[0]].rstrip("\r\n") != begin or lines[positions[1]].rstrip("\r\n") != finish:
            raise ValueError("Incomplete codex-proxy-guard rules")
        del lines[positions[0]:positions[1] + 1]
        start, end = section("rules")
    catchalls = [i for i in range(start + 1, end) if re.match(r"\s*- (?:MATCH|FINAL),", lines[i])]
    if len(catchalls) != 1 or lines[catchalls[0]].strip() != "- MATCH,AUTO":
        raise ValueError("Expected the existing MATCH,AUTO catch-all")
    block = [begin,
             "  # OpenAI HTTPS uses KIX even while AUTO falls back for VPN login."]
    block += ["  - DOMAIN-SUFFIX,{},KIX".format(domain) for domain in
              ("openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com")]
    block += ["  # KIX rejects CONNECT to other ports; do not let unrelated",
              "  # HTTP/push traffic trigger pool-wide health checks.",
              "  - NOT,((DST-PORT,443)),DIRECT", finish]
    lines[catchalls[0]:catchalls[0]] = [line + newline for line in block]
    return "".join(lines)


def parse_dns_ips(value):
    if not value.strip():
        return []
    result = []
    for item in value.split(","):
        item = item.strip()
        if not item or "%" in item:
            raise ValueError("DNS entries must be IP literals without empty entries or scope IDs")
        try:
            address = ipaddress.ip_address(item)
        except ValueError as exc:
            raise ValueError("Invalid DNS IP address: {!r}".format(item)) from exc
        endpoint = "tcp://[{}]".format(address) if address.version == 6 else "tcp://{}".format(address)
        if endpoint not in result:
            result.append(endpoint)
    return result


def replace_dns_block(text, dns_ips):
    endpoints = parse_dns_ips(dns_ips)
    lines = text.splitlines(keepends=True)
    # Do not accidentally rewrite only one document or miss a complex YAML key.
    for line in lines:
        stripped = line.rstrip("\r\n")
        if re.match(r"^(?:---|\.\.\.)(?:[ \t]*(?:#.*)?)?$", stripped):
            raise ValueError("YAML document markers are unsupported; use one plain mapping")
        if re.match(r"^\?(?:\s|$)", stripped):
            raise ValueError("Complex top-level YAML keys are unsupported")
    positions = [index for index, line in enumerate(lines) if DNS_KEY.match(line)]
    if len(positions) != 1:
        raise ValueError("Expected exactly one top-level dns block, found {}".format(len(positions)))
    start = positions[0]
    if not DNS_HEADER.fullmatch(lines[start].rstrip("\r\n")):
        raise ValueError("The top-level dns value must use block-style YAML")

    end = start + 1
    while end < len(lines):
        line = lines[end]
        if line.strip() and not line.lstrip().startswith("#"):
            if not line.startswith((" ", "\t")):
                break
            if line.startswith("\t"):
                raise ValueError("Tabs cannot indent the dns mapping")
        end += 1
    # Preserve separator whitespace and comments belonging to the next field.
    while end > start + 1 and (not lines[end - 1].strip() or lines[end - 1].lstrip().startswith("#")):
        end -= 1

    first_newline = re.search(r"\r\n|\n|\r", text)
    newline = first_newline.group() if first_newline else "\n"
    block = [
        "dns:",
        "  enable: true",
        '  listen: ""',
        "  ipv6: false",
        "  enhanced-mode: redir-host",
        "  nameserver: [system]",
        "  direct-nameserver: [system]",
    ]
    if endpoints:
        block.append("  proxy-server-nameserver:")
        block.extend("    - {}".format(endpoint) for endpoint in endpoints)
    else:
        block.append("  proxy-server-nameserver: [system]")
    return "".join(lines[:start]) + newline.join(block) + newline + "".join(lines[end:])


def generate_candidate(config, dns_ips, output, stabilize=False):
    config = Path(config)
    output = Path(output)
    if config.resolve() == output.resolve():
        raise ValueError("Output must differ from the input configuration")
    if output.is_symlink():
        raise ValueError("Output must not be a symbolic link")
    # Complete validation before creating or replacing anything at the output.
    original = config.read_bytes().decode("utf-8")
    generated = replace_dns_block(original, dns_ips)
    if stabilize:
        generated = stabilize_routing(generated)
    generated = generated.encode("utf-8")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".proxy-dns-", dir=output.parent, delete=False) as candidate:
            temporary = Path(candidate.name)
            candidate.write(generated)
            candidate.flush()
            os.fsync(candidate.fileno())
        os.replace(temporary, output)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path, help="Existing Mihomo YAML configuration")
    parser.add_argument("dns_ips", help='Comma-separated DNS IPs; pass "" to use system DNS')
    parser.add_argument("--output", required=True, type=Path, help="Candidate path, distinct from the input")
    parser.add_argument("--stabilize-routing", action="store_true", help="Also repair ChinaProxy's KIX routing and health checks")
    args = parser.parse_args()
    try:
        output = generate_candidate(args.config, args.dns_ips, args.output, args.stabilize_routing)
    except (ValueError, OSError) as exc:
        print("proxy-dns: {}".format(exc), file=sys.stderr)
        return 1
    print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
