import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { McpApplyResult, McpManagerSnapshot, McpPluginVersionInfo, McpServerDraft, McpServerState, McpServerStatus } from 'dsh-mcp-mgr/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsPluginsTabOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { McpServerForm } from './McpServerForm.tsx'
import type { McpLocaleKey } from './locales.ts'
import css from './McpSettingsTab.module.css'

/** localStorage key for the strict-mode checkbox. */
export const STRICT_MODE_KEY = 'dsh.mcpMgr.strictMode'

/** localStorage key for the last selected workspace scope. */
const SCOPE_KEY = 'dsh.mcpMgr.scope'

/** Sentinel value for the "Global" scope (profile-level servers). */
const SCOPE_GLOBAL = '__global__'

/** Persisted strict-mode preference; null when never set (host default applies). */
export function loadStrictMode(): boolean | null {
  const stored = localStorage.getItem(STRICT_MODE_KEY)
  if (stored === null) return null
  return stored === '1'
}

/** One workspace row the add-form may target. */
export interface WorkspaceOption {
  readonly path: string
  readonly title: string
}

/** Registration-side Remote face used by the tab. */
export interface McpSettingsTabInjected {
  /** Read a current manager snapshot. */
  snapshot: () => Promise<McpManagerSnapshot>
  /** Create one server entry in a workspace's mcp.json. */
  apply: (draft: McpServerDraft) => Promise<McpApplyResult>
  /** Remove one server from a workspace's mcp.json. */
  removeServer: (workspace: string, name: string) => Promise<McpApplyResult>
  /** Enable/disable one server in a workspace's mcp.json. */
  setServerEnabled: (workspace: string, name: string, enabled: boolean) => Promise<McpApplyResult>
  /** Toggle strict mode host-side; resolves with the post-change snapshot. */
  setStrictMode: (enabled: boolean) => Promise<McpManagerSnapshot>
  /** Change the relative path of the mcp.json file inside each workspace. */
  setMcpJsonRelPath: (relPath: string) => Promise<McpManagerSnapshot>
  /** Read a server's event log content. */
  readServerLog: (workspace: string, serverName: string) => Promise<string>
  /** Self-update check result (startup npm lookup). */
  versionInfo: () => Promise<McpPluginVersionInfo>
  /** Registered workspaces for the add-form target picker. */
  listWorkspaces: () => readonly WorkspaceOption[]
  /** Workspace of the currently open session ('' when none). */
  currentWorkspacePath: () => string
}

/** Full component props assembled by the Settings slot renderer. */
export type McpSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & SettingsPluginsTabOwnerProps
  & PropsLocale<'settings.mcpMgr'>
  & InjectFace<McpSettingsTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: McpManagerSnapshot }

/** Badge label key for one display status (raw status + connectivity derivation). */
const DISPLAY_KEYS = {
  connected: 'connected',
  registered: 'active',
  connecting: 'connecting',
  active: 'active',
  error: 'errorStatus',
  conflict: 'conflict',
  removing: 'removing',
  configured: 'configured',
  disabled: 'disabled',
} satisfies Record<DisplayStatus, McpLocaleKey>

/** Display status: an 'active' row reports real connectivity when probed. */
type DisplayStatus = 'connected' | 'registered' | McpServerStatus

function displayStatus(server: McpServerState): DisplayStatus {
  return server.status === 'active'
    ? (server.connected === true ? 'connected' : 'registered')
    : server.status
}

/** Render the currently registered MCP servers (workspace + profile sources). */
export function McpSettingsTab({
  snapshot, apply, removeServer, setServerEnabled, setStrictMode, setMcpJsonRelPath, readServerLog, versionInfo, listWorkspaces, currentWorkspacePath, t,
}: McpSettingsTabProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [updateInfo, setUpdateInfo] = useState<McpPluginVersionInfo | null>(null)
  const [strictMode, setStrictModeState] = useState<boolean>(() => loadStrictMode() ?? false)
  const [showForm, setShowForm] = useState(false)
  const [pathInput, setPathInput] = useState('')
  const [pathSaving, setPathSaving] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  // Workspace scope selector: SCOPE_GLOBAL or a workspace path.
  const [selectedScope, setSelectedScope] = useState<string>(() => {
    return localStorage.getItem(SCOPE_KEY) ?? SCOPE_GLOBAL
  })

  const workspaces = listWorkspaces()

  // Persist scope choice; fall back to global when the stored workspace no longer exists.
  const effectiveScope = useMemo(() => {
    if (selectedScope === SCOPE_GLOBAL) return SCOPE_GLOBAL
    if (workspaces.some(ws => ws.path === selectedScope)) return selectedScope
    return SCOPE_GLOBAL
  }, [selectedScope, workspaces])

  const onScopeChange = (value: string): void => {
    setSelectedScope(value)
    localStorage.setItem(SCOPE_KEY, value)
    setExpanded(null)
  }

  useEffect(() => {
    let current = true
    void versionInfo().then(
      (info) => { if (current) setUpdateInfo(info) },
      () => { if (current) setUpdateInfo(null) },
    )
    return () => { current = false }
  }, [versionInfo])

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => snapshot()).then(
      (value) => { if (current) { setState({ status: 'ready', snapshot: value }); setPathInput(value.mcpJsonRelPath); setErrorDetail(null) } },
      (error) => {
        if (current) {
          setState({ status: 'error' })
          setErrorDetail(String(error instanceof Error ? error.message : error))
        }
      },
    )
    return () => { current = false }
  }, [snapshot, request])

  // Filter servers by the selected scope.
  const scopedServers = useMemo(() => {
    const all = state.status === 'ready' ? state.snapshot.servers : []
    if (effectiveScope === SCOPE_GLOBAL) {
      return all.filter(s => s.source === 'profile')
    }
    return all.filter(s => s.source === 'workspace' && s.workspace === effectiveScope)
  }, [state, effectiveScope])

  const retry = (): void => {
    setNotice(null)
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  const onRemove = async (server: McpServerState): Promise<void> => {
    if (server.workspace === undefined) return
    setBusy(server.key)
    setNotice(null)
    let result: McpApplyResult
    try {
      result = await removeServer(server.workspace, server.name)
    } catch (error) {
      setBusy(null)
      setNotice(`${t('applyFailed')}: ${String(error instanceof Error ? error.message : error)}`)
      return
    }
    setBusy(null)
    setExpanded(null)
    setState({ status: 'loading' })
    setRequest(value => value + 1)
    setNotice(result.ok ? t('removed') : `${t('applyFailed')}: ${result.error}`)
  }

  const onAdded = (_workspace: string): void => {
    setShowForm(false)
    setState({ status: 'loading' })
    setRequest(value => value + 1)
    setNotice(strictMode ? t('addedStrict') : t('added'))
  }

  const onToggleEnabled = async (server: McpServerState, enabled: boolean): Promise<void> => {
    if (server.workspace === undefined) return
    setBusy(server.key)
    setNotice(null)
    let result: McpApplyResult
    try {
      result = await setServerEnabled(server.workspace, server.name, enabled)
    } catch (error) {
      setBusy(null)
      setNotice(`${t('applyFailed')}: ${String(error instanceof Error ? error.message : error)}`)
      return
    }
    setBusy(null)
    setState({ status: 'loading' })
    setRequest(value => value + 1)
    setNotice(result.ok ? (enabled ? t('started') : t('stopped')) : `${t('applyFailed')}: ${result.error}`)
  }

  const onToggleStrict = async (enabled: boolean): Promise<void> => {
    setStrictModeState(enabled)
    localStorage.setItem(STRICT_MODE_KEY, enabled ? '1' : '0')
    setNotice(null)
    try {
      const snapshot = await setStrictMode(enabled)
      setState({ status: 'ready', snapshot })
    } catch (error) {
      setStrictModeState(!enabled)
      setNotice(`${t('applyFailed')}: ${String(error instanceof Error ? error.message : error)}`)
    }
  }

  const onSavePath = async (): Promise<void> => {
    const trimmed = pathInput.trim()
    if (trimmed.length === 0) return
    setPathSaving(true)
    setNotice(null)
    try {
      const snap = await setMcpJsonRelPath(trimmed)
      setState({ status: 'ready', snapshot: snap })
      setPathInput(snap.mcpJsonRelPath)
      const workspaceServerCount = snap.servers.filter(s => s.source === 'workspace').length
      setNotice(workspaceServerCount > 0
        ? t('mcpJsonPathSavedWithServers').replace('{count}', String(workspaceServerCount))
        : t('mcpJsonPathSavedNoServers'))
    } catch (error) {
      setNotice(`${t('applyFailed')}: ${String(error instanceof Error ? error.message : error)}`)
    } finally {
      setPathSaving(false)
    }
  }

  const currentRelPath = state.status === 'ready' ? state.snapshot.mcpJsonRelPath : ''
  const pathDirty = pathInput.trim() !== '' && pathInput.trim() !== currentRelPath

  // Resolved config file path for the selected workspace scope.
  const scopeConfigFile = useMemo(() => {
    if (effectiveScope === SCOPE_GLOBAL || currentRelPath === '') return undefined
    return `${effectiveScope}/${currentRelPath}`
  }, [effectiveScope, currentRelPath])

  // Default workspace for the add-form: use the scoped workspace when viewing
  // a workspace scope; otherwise fall back to the current session workspace.
  const addFormDefaultWorkspace = effectiveScope !== SCOPE_GLOBAL ? effectiveScope : currentWorkspacePath()

  return (
    <div className={css.section} aria-busy={state.status === 'loading'}>
      {notice !== null ? <Toast text={notice} onDone={() => { setNotice(null) }} /> : null}
      {updateInfo?.updateAvailable === true ? (
        <div className={css.update} role="status">
          {t('updateAvailable')}
          {' '}
          <a href={updateInfo.updateUrl} target="_blank" rel="noreferrer">{updateInfo.updateUrl}</a>
          {' '}
          {t('updateAvailableLink')}
        </div>
      ) : null}

      {/* Workspace scope selector */}
      <div className={css.scopeRow}>
        <label className={css.scopeLabel}>{t('scopeLabel')}</label>
        <select
          className={css.scopeSelect}
          value={effectiveScope}
          onChange={(e) => { onScopeChange(e.target.value) }}
        >
          <option value={SCOPE_GLOBAL}>{t('scopeGlobal')}</option>
          {workspaces.map(ws => (
            <option key={ws.path} value={ws.path}>{ws.title}</option>
          ))}
        </select>
      </div>

      {/* Per-workspace config file path info */}
      {scopeConfigFile !== undefined ? (
        <div className={css.scopeInfo}>
          <span className={css.scopeInfoLabel}>{t('scopeConfigPath')}</span>
          <code className={css.scopeInfoValue}>{scopeConfigFile}</code>
        </div>
      ) : null}

      <div className={css.pathRow}>
        <label className={css.pathLabel} title={t('mcpJsonPathHint')}>
          {t('mcpJsonPathLabel')}
        </label>
        <input
          type="text"
          className={css.pathInput}
          value={pathInput}
          placeholder={currentRelPath}
          onChange={(event) => { setPathInput(event.target.value) }}
        />
        <button
          type="button"
          className={css.refresh}
          disabled={!pathDirty || pathSaving}
          onClick={() => { void onSavePath() }}
        >
          {t('mcpJsonPathSave')}
        </button>
      </div>
      <div className={css.heading}>
        <h3>{t('server')}</h3>
        <div className={css.headingActions}>
          <label className={css.strictLabel} title={t('strictModeHint')}>
            <input
              type="checkbox"
              checked={strictMode}
              onChange={(event) => { void onToggleStrict(event.target.checked) }}
            />
            {t('strictMode')}
          </label>
          {effectiveScope !== SCOPE_GLOBAL ? (
            <button
              type="button"
              className={css.add}
              disabled={workspaces.length === 0}
              title={workspaces.length === 0 ? t('noWorkspace') : undefined}
              onClick={() => { setShowForm(true) }}
            >
              {t('add')}
            </button>
          ) : null}
          <button type="button" className={css.refresh} onClick={retry}>{t('refresh')}</button>
        </div>
      </div>
      {showForm ? (
        <McpServerForm
          workspaces={workspaces}
          defaultWorkspace={addFormDefaultWorkspace}
          submit={apply}
          t={t}
          onClose={() => { setShowForm(false) }}
          onAdded={onAdded}
        />
      ) : null}
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          {errorDetail !== null ? <p className={css.errorText} role="alert">{errorDetail}</p> : null}
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' && scopedServers.length === 0
        ? <p className={css.status}>{t('scopeNoServers')}</p>
        : null}
      {scopedServers.length > 0 ? (
        <table className={css.table}>
          <thead>
            <tr>
              <th>{t('server')}</th>
              <th>{t('transport')}</th>
              <th>{t('status')}</th>
            </tr>
          </thead>
          <tbody>
            {scopedServers.map((server) => {
              const status = displayStatus(server)
              const isExpanded = expanded === server.key
              const fullPath = server.source === 'workspace' ? server.workspace : server.sourceFile
              return (
                <ServerRow
                  key={server.key}
                  server={server}
                  status={status}
                  fullPath={fullPath}
                  isExpanded={isExpanded}
                  busy={busy === server.key}
                  onToggleExpand={() => { setExpanded(isExpanded ? null : server.key) }}
                  onToggleEnabled={(enabled) => { void onToggleEnabled(server, enabled) }}
                  onRemove={() => { void onRemove(server) }}
                  onViewLog={server.source === 'workspace' && server.workspace !== undefined
                    ? async () => {
                      const content = await readServerLog(server.workspace!, server.name)
                      if (content.length === 0) {
                        setNotice(t('logEmpty'))
                        return
                      }
                      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
                      const url = URL.createObjectURL(blob)
                      window.open(url, '_blank')
                    }
                    : undefined}
                  t={t}
                />
              )
            })}
          </tbody>
        </table>
      ) : null}
    </div>
  )
}

/** One server row + its expandable detail panel. */
function ServerRow({ server, status, fullPath, isExpanded, busy, onToggleExpand, onToggleEnabled, onRemove, onViewLog, t }: {
  server: McpServerState
  status: DisplayStatus
  fullPath: string | undefined
  isExpanded: boolean
  busy: boolean
  onToggleExpand: () => void
  onToggleEnabled: (enabled: boolean) => void
  onRemove: () => void
  onViewLog: (() => void) | undefined
  t: (key: McpLocaleKey) => string
}): ReactNode {
  return (
    <>
      <tr
        className={`${css.serverRow} ${isExpanded ? css.serverRowExpanded : ''}`}
        data-source={server.source}
        onClick={onToggleExpand}
      >
        <td className={css.nameCell} title={server.name}>{server.name}</td>
        <td className={css.nowrapCell} title={server.transport}>{server.transport}</td>
        <td className={css.nowrapCell}>
          <span
            className={css.statusBadge}
            data-status={status}
            title={
              status === 'connected' ? t('connectedHint')
                : status === 'registered' ? t('activeHint')
                : undefined
            }
          >
            {t(DISPLAY_KEYS[status])}
          </span>
        </td>
      </tr>
      {isExpanded ? (
        <tr className={css.detailRow} data-source={server.source}>
          <td colSpan={3}>
            <div className={css.detailPanel}>
              {/* Info section */}
              <div className={css.detailGrid}>
                <span className={css.detailLabel}>{t('detailSource')}</span>
                <span className={css.detailValue}>{server.source === 'workspace' ? t('detailSourceWorkspace') : t('detailSourceProfile')}</span>

                {fullPath !== undefined ? (
                  <>
                    <span className={css.detailLabel}>{server.source === 'workspace' ? t('detailWorkspace') : t('detailSourceFile')}</span>
                    <span className={css.detailValue + ' ' + css.detailMono}>{fullPath}</span>
                  </>
                ) : null}

                {server.clientPhase !== undefined ? (
                  <>
                    <span className={css.detailLabel}>{t('detailPhase')}</span>
                    <span className={css.detailValue}>{server.clientPhase}</span>
                  </>
                ) : null}

                {server.pid !== undefined ? (
                  <>
                    <span className={css.detailLabel}>{t('detailPid')}</span>
                    <span className={css.detailValue + ' ' + css.detailMono}>{server.pid}</span>
                  </>
                ) : null}

                {server.connectedAt !== undefined ? (
                  <>
                    <span className={css.detailLabel}>{t('detailConnectedAt')}</span>
                    <span className={css.detailValue}>{new Date(server.connectedAt).toLocaleTimeString()}</span>
                  </>
                ) : null}

                {server.failedAttempts !== undefined && server.failedAttempts > 0 ? (
                  <>
                    <span className={css.detailLabel}>{t('detailReconnect')}</span>
                    <span className={css.detailValue + ' ' + css.detailErrorValue}>
                      {server.failedAttempts}/{server.maxAttempts}
                      {server.nextReconnectAt !== undefined
                        ? ` — ${t('detailNextRetry')} ${new Date(server.nextReconnectAt).toLocaleTimeString()}`
                        : null}
                    </span>
                  </>
                ) : null}

                {server.error !== undefined ? (
                  <>
                    <span className={css.detailLabel}>{t('detailError')}</span>
                    <span className={css.detailValue + ' ' + css.detailErrorValue}>{server.error}</span>
                  </>
                ) : null}

                {server.lastError !== undefined ? (
                  <>
                    <span className={css.detailLabel}>{t('detailLastError')}</span>
                    <span className={css.detailValue + ' ' + css.detailErrorValue}>{server.lastError}</span>
                  </>
                ) : null}

                {status === 'registered' && server.probeError !== undefined ? (
                  <>
                    <span className={css.detailLabel}>{t('detailProbeError')}</span>
                    <span className={css.detailValue + ' ' + css.detailErrorValue}>{server.probeError}</span>
                  </>
                ) : null}

                {server.stderrTail !== undefined ? (
                  <>
                    <span className={css.detailLabel}>{t('detailStderr')}</span>
                    <pre className={css.detailValue + ' ' + css.detailMono + ' ' + css.detailStderr}>
                      {server.stderrTail}
                    </pre>
                  </>
                ) : null}
              </div>

              {/* Actions */}
              {server.source === 'workspace' ? (
                <div className={css.detailActions}>
                  {onViewLog !== undefined ? (
                    <button
                      type="button"
                      className={css.toggle}
                      onClick={(e) => { e.stopPropagation(); void onViewLog() }}
                    >
                      {t('viewLog')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={css.toggle}
                    disabled={busy}
                    onClick={(e) => { e.stopPropagation(); onToggleEnabled(server.enabled === false) }}
                  >
                    {server.enabled === false ? t('start') : t('stop')}
                  </button>
                  <button
                    type="button"
                    className={css.danger}
                    disabled={busy}
                    onClick={(e) => { e.stopPropagation(); onRemove() }}
                  >
                    {t('remove')}
                  </button>
                </div>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}
