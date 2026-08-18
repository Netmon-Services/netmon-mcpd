# Netmon MCP

Connect an AI assistant to a Netmon appliance.

Netmon ships an MCP server on the appliance itself. This repository holds the client-side bridge: a small Node process that runs on your own machine, speaks stdio to Claude Desktop, and forwards every JSON-RPC message to your Netmon's `/mcp` endpoint over HTTPS.

Once connected, an assistant can read your devices, interfaces, logs, flow records, alerts, and Windows-agent data by calling Netmon's tools directly — with the same sign-in and permissions as any operator, and the same tag restrictions.

- **Product overview:** <https://netmon.com/netmon-ai-assistants/>
- **Setup guide:** <https://netmon.com/netmon-7-user-guide/api-and-integrations/>
- **API reference:** <https://netmon.com/api-reference/authentication/>

---

## Why a local bridge

Claude connects to remote MCP servers from Anthropic's cloud infrastructure, not from your machine. A Netmon appliance on a private network is not reachable from there.

The bridge runs as a local process, so it can reach the appliance on your LAN. That is the whole reason this repository exists — and it means the supported clients are **Claude Desktop** and **Claude Code**, not claude.ai in a browser.

If your appliance is internet-facing with a publicly-trusted certificate, you can skip the bridge and point any MCP client straight at the endpoint. See [Install — any MCP client](#install--any-mcp-client) below.

---

## Requirements

- A Netmon appliance with the MCP server enabled (Netmon 7.0.20 or newer).
- A user account with the **API** permission, and a personal access token carrying the `mcp:*` scopes you want the assistant to have.
- Claude Desktop for the `.mcpb` install. Claude Desktop supplies its own Node runtime, so nothing else is needed. Running the bridge outside Claude Desktop requires Node 18 or newer.

---

## Install — Claude Desktop

1. Download `netmon-mcpd-<version>.mcpb` from [Releases](https://github.com/Netmon-Services/netmon-mcpd/releases). The same bundle ships with your appliance — **Settings → System → Downloadables → Claude Desktop Extension**.
2. In Claude Desktop, open **Settings → Extensions → Advanced settings → Extension Developer → Install Extension…** and select the file.
3. Fill in the two settings the extension asks for:

   | Setting | Value |
   |---|---|
   | **Netmon URL** | `https://<your-netmon>/mcp` — the full endpoint, including `/mcp` |
   | **API Token** | a personal access token (see below). The `Bearer ` prefix is added for you if you leave it off. |

4. Restart the extension. Ask Claude something like *"list the devices that are down"* to confirm it is working.

### Minting a token

In Netmon, go to **Settings → Users**, click the key icon on your user, and create a personal access token. Select only the scopes the assistant needs — the token cannot be widened later, and it can be revoked from the same screen at any time.

The account must hold the **API** permission. Without it, token minting and OAuth consent are both refused.

---

## Install — any MCP client

The appliance serves Streamable HTTP at `https://<your-netmon>/mcp` (`POST` for JSON-RPC, `GET` for the server-to-client SSE stream, `DELETE` to end a session).

Clients that support OAuth 2.1 discover the authorization server on their own: the endpoint answers an unauthenticated request with `401` and a `WWW-Authenticate: Bearer resource_metadata="…"` challenge pointing at RFC 9728 protected-resource metadata, alongside RFC 8414 authorization-server metadata and dynamic client registration at `/auth/register`. You sign in through your browser on your own Netmon and approve the scopes on a consent page.

Clients without OAuth support pass a token directly:

```json
{
  "mcpServers": {
    "netmon": {
      "url": "https://netmon.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

### Claude Code and self-signed certificates

Most appliances serve a self-signed certificate. A direct `type: http` entry will fail against one — the OAuth bootstrap rejects the certificate and does not consult `NODE_EXTRA_CA_CERTS`. Use the bridge instead, which handles the certificate itself:

```json
{
  "mcpServers": {
    "netmon": {
      "command": "node",
      "args": ["/path/to/netmon-mcpd/server/index.js"],
      "env": {
        "NETMON_URL": "https://netmon.example.com/mcp",
        "NETMON_TOKEN": "<your-token>"
      }
    }
  }
}
```

---

## Tools

36 read tools, each wrapping a Netmon API endpoint and gated by an OAuth scope that is checked before the call runs.

| Area | Scope | Example tools |
|---|---|---|
| Devices & fleet | `mcp:devices` | `device_find`, `device_get`, `device_list`, `device_metric_summary`, `overwatch_summary`, `tags_list` |
| Traffic & topology | `mcp:vne`, `mcp:devices` | `top_bandwidth`, `netflow_search`, `netflow_raw_search`, `flow_summary`, `get_network_entity_info`, `arp_table`, `interfaces_search` |
| Logs & security | `mcp:logs` | `syslog_search`, `eventlog_search`, `eve_search`, `eve_get`, `log_severity_summary`, `syslog_facets` |
| Alerts | `mcp:alerts` | `alerts_list`, `alerts_history`, `maintenance_windows_list` |
| Windows agent | `mcp:devices` | `agent_processes`, `agent_services`, `agent_disk_usage` |
| Live tools | `mcp:tools`, `mcp:devices`, `mcp:capture` | `ping`, `traceroute`, `arp_lookup`, `port_map`, `snmp_test`, `snmp_walk_run`, `snmp_walk_last`, `search_ip`, `speedtest_history`, `capture_list`, `capture_get` |

Eight scopes exist in total — the six above plus `mcp:reports` and `mcp:system`, which map to their permissions but have no tools yet.

---

## Security model

**Everything stays on your appliance.** The bridge connects to the one URL you configure and nothing else. No telemetry, no vendor endpoint, no third-party service sits in the path. Netmon Services receives nothing.

**Read-only.** Every tool is a read. Netmon's agent write paths — killing a process, starting or stopping a Windows service, deleting a file, running PowerShell — are permanently excluded at the MCP layer, regardless of what the underlying token's permissions would otherwise allow. An assistant cannot change your monitoring configuration, acknowledge an alert, or act on a managed host.

**Scoped.** Each tool declares the OAuth scope it requires, and the scope is checked before the tool body runs. A token granted `mcp:logs` only cannot call `device_list`.

**Yours, and no wider.** A token acts as the user who minted it. Tag restrictions apply: an operator limited to the `branch-offices` tag gets an assistant limited to the same devices. The permission model is the one already governing the web interface and every other API client.

**Revocable.** Revoke a token from **Settings → Users** and the assistant loses access immediately. Tokens can also be scoped narrowly at mint time rather than revoked later.

### Transport security

On first connection the bridge captures the appliance's TLS certificate and stores it at `~/.netmon-mcpd/<hash-of-url>.pem`, then verifies every later connection against that pinned certificate. This is trust-on-first-use: it protects against interception after the first connection, not during it. Make the first connection from a network you trust.

If you replace the appliance's certificate, delete the stale pin (`rm ~/.netmon-mcpd/*.pem`) or the bridge will verify the new certificate against the old one and refuse to connect.

The bridge requires `https://`. Plain HTTP is rejected at startup.

---

## Troubleshooting

The bridge writes a diagnostic log to `~/.netmon-mcpd/wrapper.log`.

| Symptom | Cause |
|---|---|
| `NETMON_URL must use https://` | The URL is `http://`, or the scheme is missing. |
| `TLS probe failed` | The appliance is unreachable on 443 from this machine, or the hostname does not resolve. |
| Connects, then fails after a certificate change | Stale pin. Delete `~/.netmon-mcpd/*.pem` and reconnect. |
| Tools return an authorization error | The token lacks the scope that tool requires, or the account lacks the **API** permission. |
| No tools appear | The URL is missing the `/mcp` path. |

---

## Building

```bash
npm install
./build.sh            # or: ./build.sh 1.0.0 to stamp a version
```

Output lands in `build/netmon-mcpd-<version>.mcpb`.

---

## Privacy Policy

Full policy: <https://netmon.com/privacy-policy/>

**What is collected.** This bridge collects no data. It holds no account, no analytics, and no callback to Netmon Services. Two files are written locally, both under `~/.netmon-mcpd/`: the pinned certificate of the appliance you configured, and a diagnostic log of connection events. Your Netmon URL and token are supplied by you and are held only in the extension's own configuration.

**How data is used and stored.** Queries and results pass between your MCP client and your appliance. The bridge forwards messages and retains none of them. All monitoring data stays in the appliance's database, under your control, in your building.

**Third-party sharing.** None. The bridge contacts exactly one host — the appliance URL you configure. It sends nothing to Netmon Services or any other party.

Note that your MCP client is a separate product with its own policy. When you ask an assistant a question, the tool results it receives are handled by that client's vendor under their terms. Netmon does not control that leg, which is why the scopes on a token are worth setting narrowly.

**Retention.** Local files persist until you delete them: remove the extension, or `rm -rf ~/.netmon-mcpd`. Revoking the token in **Settings → Users** ends access immediately. Retention of the monitoring data itself is configured on your appliance, by you.

**Contact.** support@netmon.com

---

## Support

- Documentation: <https://netmon.com/documentation/>
- Issues with the bridge: [GitHub Issues](https://github.com/Netmon-Services/netmon-mcpd/issues)
- Everything else: support@netmon.com

## License

<!-- Choose one before publishing; MIT or Apache-2.0. -->
