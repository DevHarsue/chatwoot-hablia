# Linear Hablia connector policy

Use `linear-hablia` only for the Hablia workspace, team `Hablia-ai`, and
`HAB-` issues. Verify the workspace through a read-only request before the
first write in a session.

The Claude and Codex manifests intentionally contain only the OAuth MCP
endpoint. Credentials remain in the client session and are never versioned.
