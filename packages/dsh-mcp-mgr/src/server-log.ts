/**
 * Per-server event log: appends timestamped lines to
 * `<workspace>/.dsh/dshmm/logs/<serverName>.log`.
 *
 * Lines are human-readable, one per event. The file is opened lazily and
 * closed when the server instance is removed. Log files are never deleted
 * by the plugin — the user manages them.
 * @module dsh-mcp-mgr/server-log
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Manages per-server log files within a workspace's dshmm directory. */
export class ServerLogWriter {
  private readonly logDir: string

  /**
   * @param workspacePath - workspace root directory.
   * @param mcpJsonRelPath - relative path of the mcp.json (e.g. `.dsh/dshmm/mcp.json`);
   *   logs live in a `logs/` sibling directory next to the mcp.json.
   */
  constructor(workspacePath: string, mcpJsonRelPath: string) {
    const mcpJsonDir = dirname(join(workspacePath, mcpJsonRelPath))
    this.logDir = join(mcpJsonDir, 'logs')
  }

  /** Append one timestamped line. */
  append(serverName: string, message: string): void {
    const path = this.path(serverName)
    mkdirSync(dirname(path), { recursive: true })
    const ts = new Date().toISOString()
    appendFileSync(path, `[${ts}] ${message}\n`, 'utf8')
  }

  /** Absolute path to a server's log file. */
  path(serverName: string): string {
    return join(this.logDir, `${serverName}.log`)
  }

  /** Read full log content; returns '' when the file doesn't exist. */
  read(serverName: string): string {
    try {
      return readFileSync(this.path(serverName), 'utf8')
    } catch {
      return ''
    }
  }
}
