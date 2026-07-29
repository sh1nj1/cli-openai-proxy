# macOS Auto-Start Setup

This guide shows how to configure cli-openai-proxy to start automatically when you log in.

## Create LaunchAgent

1. Create the plist file:

```bash
cat > ~/Library/LaunchAgents/com.cli-openai-proxy.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.cli-openai-proxy</string>
    
    <key>Comment</key>
    <string>cli-openai-proxy — agentic coding CLIs behind an OpenAI-compatible API</string>
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>KeepAlive</key>
    <true/>
    
    <key>ProgramArguments</key>
    <array>
      <string>/opt/homebrew/bin/node</string>
      <string>/path/to/cli-openai-proxy/dist/server/standalone.js</string>
    </array>
    
    <key>StandardOutPath</key>
    <string>/tmp/cli-openai-proxy.log</string>
    
    <key>StandardErrorPath</key>
    <string>/tmp/cli-openai-proxy.err.log</string>
    
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>/Users/YOUR_USERNAME</string>
      <key>PATH</key>
      <string>/Users/YOUR_USERNAME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
  </dict>
</plist>
PLIST
```

2. **Important:** Edit the file and replace:
   - `/path/to/cli-openai-proxy` with your actual path
   - `/Users/YOUR_USERNAME` with your actual username
   - Ensure the PATH includes the directory containing `claude` (check with `which claude`)

## Load the Service

```bash
# Load and start the service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cli-openai-proxy.plist

# Verify it's running
launchctl list | grep cli-openai-proxy
curl http://localhost:3456/health
```

## Management Commands

```bash
# Check status
launchctl list | grep cli-openai-proxy

# Restart the service
launchctl kickstart -k gui/$(id -u)/com.cli-openai-proxy

# Stop the service (temporary)
launchctl bootout gui/$(id -u)/com.cli-openai-proxy

# Start the service again
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cli-openai-proxy.plist

# View logs
tail -f /tmp/cli-openai-proxy.log
tail -f /tmp/cli-openai-proxy.err.log
```

## Uninstall

```bash
# Stop and remove the service
launchctl bootout gui/$(id -u)/com.cli-openai-proxy
rm ~/Library/LaunchAgents/com.cli-openai-proxy.plist
```

## Troubleshooting

### Service starts but health check fails

Check the error log:
```bash
cat /tmp/cli-openai-proxy.err.log
```

Common issues:
- Wrong path to `standalone.js`
- `claude` CLI not in PATH
- Node.js not found

### Finding the right paths

```bash
# Find node
which node

# Find claude
which claude

# Your home directory
echo $HOME
```
