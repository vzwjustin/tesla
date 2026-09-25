# AI Client Compatibility Notes

## Local stdio clients

Claude Desktop supports local MCP servers through its Desktop Extensions workflow. A custom extension can package an MCP server, and a local Node MCP process can use securely stored configuration values. Source: https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop

Gemini CLI supports stdio, SSE, and Streamable HTTP MCP transports through `mcpServers` in `settings.json`. A local stdio command may include a working directory and environment variables; Gemini CLI also supports an `httpUrl` for Streamable HTTP. Source: https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html

## ChatGPT remote access

ChatGPT cannot connect to a local MCP server directly. Its developer mode supports remote MCP apps. OpenAI’s Secure MCP Tunnel can connect a private local stdio or HTTP MCP server to supported OpenAI products through an outbound-only HTTPS path, avoiding public inbound exposure. It requires a Platform tunnel ID, a runtime key for `tunnel-client`, appropriate tunnel permissions, and the target ChatGPT workspace association. Sources: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt and https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

The ChatGPT help document states that developer mode/full MCP support availability varies by plan and workspace role. It identifies Business and Enterprise/Edu as the main full-MCP availability path, and says Pro supports read/fetch permissions in developer mode.

## Security boundary

The local dashboard and the HTTP MCP companion bind to `127.0.0.1` by default and require bearer credentials. Tesla credentials and local diagnostic exports should remain in private configuration files. Do not expose the dashboard port directly to the public internet. Use an official secure tunnel only for ChatGPT when its plan/workspace supports it.
