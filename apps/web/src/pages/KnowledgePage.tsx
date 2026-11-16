import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useLang, useT, type Dict } from '../i18n';
import './KnowledgePage.css';
import { DatabaseSourcePanel } from './DatabaseSourcePanel';
import { MaterialReview, type Material } from './MaterialReview';

interface Evidence { sourceId: string; version: string; start: number; end: number; locator: string; quote: string }
interface Plugin { id: string; name: string; enabled: boolean; configured: boolean; capabilities: string[] }
interface SourceScope { resourceId?: string; mailbox?: string; folder?: string; receivedSince?: string; driveId?: string; folderPath?: string; projectIds?: string[]; mcpResourceCount?: number; publicMcpEndpoint?: string }
interface SourceResource { id: string; name: string; pluginId: string; scope: SourceScope; projectIds: string[] }
interface Connection { id: string; name: string; pluginId: string; status: string; scope?: SourceScope }
interface ConnectionPreview { connectionId: string; name: string; pluginId: string; status: string; scope: SourceScope; items: { id: string; title: string; version: string; locator: string; selected: boolean }[]; blocked: number }
type Item = Material;
interface Recommendation {
  id: string; kind: string; name: string; description: string; humanLocked: boolean; deleted: boolean; stale?: boolean;
  proposedChange?: { name: string; description: string; evidence?: Evidence[] }; evidence: Evidence[];
  relation?: { from: string; to: string; label: string };
  origin?: 'manual' | 'inferred';
}
interface Overview {
  spaceName: string; sourceResources: SourceResource[];
  plugins: Plugin[]; connections: Connection[]; items: Item[];
  analyses: { id: string; status: string; stage: string }[]; recommendations: Recommendation[];
  canConfirm: boolean;
  parseJobs: { id: string; name: string; status: string; error: string | null }[];
  databaseResources?: { id: string; name: string; tables: Record<string, { columns: string[]; sensitive?: string[] }>; maxRows: number }[];
}
interface SearchResult { answer: string; hits: Evidence[] }
interface FileSubmission { name: string; status: 'uploading' | 'submitted' | 'failed'; error?: string }
const ROOT = '/api/v1/knowledge';
const DEFAULT_SPACE_NAME = '企业知识';
const ENGLISH_PLUGINS: Record<string, { name: string; capabilities: string[] }> = {
  'local-file': { name: 'Local files', capabilities: ['File import', 'Version and line references'] },
  email: { name: 'Enterprise email', capabilities: ['Approved mailbox', 'Incremental sync'] },
  sharepoint: { name: 'SharePoint', capabilities: ['Document library scope', 'Source permission sync'] },
  database: { name: 'Read-only database', capabilities: ['Schema knowledge', 'Controlled live queries'] },
  mcp: { name: 'MCP', capabilities: ['Approved servers', 'Read-only resources'] },
};

const TEXT = {
  en: {
    manageSources: 'Manage sources',
    badgeAutomatic: 'Automatic',
    badgeConnected: 'Connected',
    badgeNeedsSetup: 'Needs setup',
    mcpEndpointLabel: 'MCP URL',
    mcpEndpointHint: 'Enter a public HTTPS Streamable HTTP endpoint with resources to import.',
    mcpApprovedTitle: 'Use an approved MCP configuration',
    mcpInvalidUrl: 'Enter a public HTTPS MCP URL.',
    mcpAuthRequired: 'This MCP server requires authorization. Use an approved configuration with credentials.',
    mcpNoResources: 'The server has no resources available to import.',
    mcpConnectionFailed: 'Could not verify this MCP URL. Check that the server is reachable over HTTPS.',
    connectionTestFailed: 'The source did not pass its connection test.',
    automaticLocal: 'Created automatically when you upload a file.',
    addMaterials: 'Add materials',
    chooseFiles: 'Choose files',
    dropFiles: 'Drop files here, or choose multiple files from your computer.',
    pasteText: 'Paste text',
    localUploadDisabled: 'Local uploads are available to knowledge managers when the local files source is enabled.',
    sendingFile: 'Uploading',
    failedFile: 'Upload failed',
    parseFileFailed: 'Readable text could not be extracted. Try a different copy of the file.',
    parseAccessFailed: 'The document parser could not access the file.',
    readyFile: 'Searchable',
    fileResults: 'File upload results',
    noMaterials: 'No materials yet.',
    mcpResources: 'Approved MCP resources',
    errUnreadableFile: 'This file could not be read.',
    errUnreadableWorkbook: 'This workbook could not be read. If it is password-protected, upload an unlocked copy.',
    errTooLarge: 'This file exceeds the upload or extracted text size limit.',
    status_draft: 'Pending confirmation',
    status_ready: 'Connection confirmed',
    status_confirmed: 'Confirmed',
    status_pending: 'Pending version',
    status_needs_auth: 'Re-auth required',
    status_needs_reauth: 'Re-auth required',
    status_sync_failed: 'Sync failed',
    status_rescan_required: 'Rescan required',
    status_paused: 'Paused',
    status_revoked: 'Access revoked',
    status_deleted: 'Deleted',
    status_parse_failed: 'Parse failed',
    status_parsed: 'Parsed · pending confirm',
    status_queued: 'Queued',
    status_running: 'Running',
    status_completed: 'Completed',
    status_failed: 'Failed',
    status_stale: 'Evidence changed',
    stage_parse: 'Parse',
    stage_extract: 'Extract',
    stage_recommend: 'Recommend',
    stage_complete: 'Complete',
    kind_employee: 'Employee',
    kind_tool: 'Tool',
    kind_sop: 'SOP',
    kind_object: 'Business object',
    kind_relation: 'Relation',
    status_outcome_unknown: 'Outcome unknown · check manually',
    reqFailed: 'Request failed. Please try again later.',
    reqFailedHttp: 'Request failed (HTTP {status})',
    evidenceLocator: 'Version {version} · Chars {start}–{end}',
    evidenceSource: 'Source {sourceId}',
    noEvidence: 'No locatable evidence; cannot generate or adopt recommendations from this.',
    scopeMailbox: 'Mailbox',
    scopeFolder: 'Mail folder',
    scopeReceivedSince: 'Emails since',
    scopeDriveId: 'Drive',
    scopeFolderPath: 'Folder path',
    scopeResourceId: 'Authorized resource',
    scopeProjects: 'Authorized projects',
    scopeNoProjects: 'No project authorization',
    importSuccess: 'Selected materials imported. Each version still needs review and confirmation.',
    syncSuccess: 'Source sync completed. New materials still need version-by-version confirmation.',
    readingPreview: 'Reading scope preview…',
    previewSourceBtn: 'Preview source scope & materials',
    syncSourceBtn: 'Sync source',
    previewAria: '{name} source metadata preview',
    previewHeading: 'Source metadata preview',
    previewHint1: 'Preview only shows allowed titles, versions, and locators, not confirmed content. Server re-checks permissions before import.',
    previewBlocked: 'Restricted materials: {count} item(s), count only, cannot be selected.',
    previewItemMeta: 'Version {version} · {locator}',
    previewEmpty: 'No importable materials in the current scope.',
    importSelectedBtn: 'Import selected materials ({count})',
    confirmConnFirst: 'Independently confirm the connection before selecting materials to import.',
    closePreviewBtn: 'Close preview',
    itemPreviewSummary: 'View current version text & locator',
    itemPreviewLoading: 'Checking source permissions and reading…',
    itemPreviewTruncated: 'Preview reached the 200,000-character limit; also check the original file.',
    recLockSuccess: 'Draft saved and locked by human.',
    recDraftKind: '{kind} draft',
    recHumanLocked: 'Human locked',
    recPendingReview: 'Suggestion · pending review',
    recOriginManual: 'Manual entry · not inferred from documents',
    recOriginInferred: 'Document-inferred · verify source evidence',
    recStaleAlert: 'Evidence version changed and old citations were withdrawn. Manual content is kept; review new suggestions before adopting.',
    recName: 'Name',
    recDesc: 'Description',
    recSaveLockBtn: 'Save & human lock',
    recDeleteSuccess: 'Draft deleted; future analyses will not restore it automatically.',
    recDeleteBtn: 'Delete draft',
    recProposalTitle: 'Analysis proposed a change without overwriting manual content',
    recAdoptSuccess: 'Change adopted and locked by human.',
    recAdoptBtn: 'Verify & adopt this change',
    recManualNoEvidence: 'Entered manually; no document-inferred evidence.',
    recViewEvidence: 'View evidence · {count} item(s)',
    connCreatedNotice: 'Connection verified. You can now choose materials to import.',
    spaceSavedNotice: 'Knowledge space name saved (metadata only).',
    manualRoleSavedNotice: 'Manual role added; this does not automatically enable material analysis.',
    uploadSuccessNotice: 'Material submitted. Confirm the current version after parsing finishes.',
    errDocRead: 'Unable to read document file.',
    pageTitle: 'Enterprise Knowledge',
    mcpTitle: 'Read knowledge via MCP',
    mcpHint: 'Connect a Streamable HTTP client using an Entra access token for Super Agent. Search and read confirmed sources you have permission to access.',
    loadingBtn: 'Loading…',
    refreshBtn: 'Refresh',
    introMain: 'Build grounded evidence from trusted sources so every recommendation traces back to the original text.',
    loadingState: 'Loading sources and knowledge status…',
    step3Cta: 'Start analysis',
    sec1Title: 'Knowledge sources',
    sec1Sub: 'Configure a source to bring its materials into the knowledge base.',
    pluginsAria: 'Source plugin catalog',
    badgePaused: 'Paused',
    capsFallback: 'Capabilities defined by server',
    pausePluginBtn: 'Pause {name}',
    enablePluginBtn: 'Enable {name}',
    pluginPausedNotice: 'Plugin paused; source data remains unchanged.',
    pluginEnabledNotice: 'Plugin enabled; review source connections.',
    configureCardBtn: 'Configure connection',
    hideConfigBtn: 'Hide form',
    confirmConnBtn: 'Confirm connection',
    retestConfirmBtn: 'Retest & confirm connection',
    connConfirmedNotice: 'Connection confirmed. Materials still need version-by-version confirmation.',
    retestConnBtn: 'Retest connection',
    connRetestedNotice: 'Connection retested and confirmed. Materials still need version-by-version confirmation.',
    noConnections: 'No external sources connected yet.',
    connFormTitle: 'Configure {name} connection',
    connNameLabel: 'Connection name',
    connNamePlaceholder: 'e.g. Team operations handbook',
    approvedResourceLabel: 'Approved source resource',
    noApprovedResource: 'No approved source resources yet',
    needAdminScope: 'Ask an admin to approve a source scope before creating a connection.',
    readOnlyAckLabel: 'I have verified the source scope and confirm read-only access only',
    connFormHint: 'Default reader is the current user. Connections are read-only; confirmation cannot override source permissions or project scopes.',
    creatingConn: 'Verifying…',
    createConnBtn: 'Verify and connect',
    sec2Title: 'Materials',
    itemNameLabel: 'Material name',
    itemNamePlaceholder: 'operations-handbook.md',
    itemTextLabel: 'Text content',
    itemTextPlaceholder: 'Or paste plain text here…',
    submitting: 'Submitting…',
    submitMaterialBtn: 'Submit material',
    parseJobsAria: 'Document parse jobs',
    parseJobsTitle: 'Document parse jobs',
    jobUnknownHint: 'Verify the cloud job and file status manually before proceeding.',
    versionMeta: 'Version {version} · {locator}',
    itemStatusPending: 'Not yet confirmed for search',
    badgeUnavailable: 'Unavailable',
    confirmItemTitle: 'Confirm version {version} after reviewing original material',
    confirmItemSuccess: 'Current material version confirmed; availability still depends on source permissions.',
    confirmItemBtn: 'Confirm this version',
    secSearchTitle: 'Grounded search',
    secSearchSub: 'Unknown-permission, unconfirmed, revoked, or expired versions are excluded from results.',
    searchLabel: 'Search enterprise materials',
    searchPlaceholder: 'Enter a question or keywords to verify',
    searchingBtn: 'Searching…',
    searchBtn: 'Search evidence',
    searchFoundDefault: 'Found the following source evidence.',
    searchNoHits: 'No currently usable evidence. Confirm source versions, check access permissions, or adjust keywords.',
    searchIdleHint: 'Answers and citations come from actual server search results; no conclusions are generated without evidence.',
    sec3Title: 'Knowledge analysis & draft recommendations',
    sec3Sub: 'Employees, tools, SOPs, and business objects are generated as drafts for human decision.',
    analyzingBtn: 'Analysis running',
    startAnalysisBtn: 'Start analysis',
    analysisSubmittedNotice: 'Analysis job submitted. Progress follows server status.',
    needConfirmedHint: 'Confirm at least one authorized material version first.',
    noAnalyses: 'No analyses run yet. Source permissions and versions are re-checked before analysis starts.',
    noRecommendations: 'No draft recommendations yet. Only analysis results with valid current citations appear here.',
    advancedSummary: 'Advanced',
    advancedHint: 'Rename space, read-only database source, and manual role entry',
    spaceFormAria: 'Knowledge space naming',
    spaceNameLabel: 'Knowledge space name',
    saveSpaceBtn: 'Save knowledge space name',
    spaceNameHint: 'Updates space name metadata only; does not copy databases or change source scopes.',
    manualRoleAria: 'Manual role entry',
    manualRoleTitle: 'Manual role entry',
    manualRoleHint: 'Record known roles manually and mark them as manual entries; never disguised as document inference and does not replace source confirmation.',
    manualRoleNameLabel: 'Manual role name',
    manualRoleDescLabel: 'Manual role description',
    addManualRoleBtn: 'Add manual role',
    retryLoadBtn: 'Retry loading knowledge status',
  },
  zh: {
    manageSources: '管理来源',
    badgeAutomatic: '自动接入',
    badgeConnected: '已连接',
    badgeNeedsSetup: '待配置',
    mcpEndpointLabel: 'MCP 地址',
    mcpEndpointHint: '填写提供可导入资源的公开 HTTPS Streamable HTTP 地址。',
    mcpApprovedTitle: '使用已授权的 MCP 配置',
    mcpInvalidUrl: '请输入公开可访问的 HTTPS MCP 地址。',
    mcpAuthRequired: '此 MCP 服务器需要授权，请选择已配置凭据的来源。',
    mcpNoResources: '此服务器没有可导入的资源。',
    mcpConnectionFailed: '无法验证 MCP 地址，请检查地址和服务器是否可访问。',
    connectionTestFailed: '来源连接测试未通过。',
    automaticLocal: '首次上传时自动创建。',
    addMaterials: '添加资料',
    chooseFiles: '选择文件',
    dropFiles: '将文件拖到这里，或从电脑一次选择多个文件。',
    pasteText: '粘贴文本',
    localUploadDisabled: '知识库管理员可在本地文件来源启用时上传资料。',
    sendingFile: '上传中',
    failedFile: '上传失败',
    parseFileFailed: '未能提取可读内容，请尝试上传另一份文件。',
    parseAccessFailed: '文档解析服务无法访问文件。',
    readyFile: '可搜索',
    fileResults: '文件上传结果',
    noMaterials: '还没有资料。',
    mcpResources: '已授权的 MCP 资源',
    errUnreadableFile: '无法读取此文件。',
    errUnreadableWorkbook: '无法读取此工作簿。如果文件受密码保护，请上传解锁后的副本。',
    errTooLarge: '文件或提取出的文本超过大小限制。',
    status_draft: '待确认',
    status_ready: '已确认连接',
    status_confirmed: '已确认',
    status_pending: '待确认版本',
    status_needs_auth: '需要重新授权',
    status_needs_reauth: '需要重新授权',
    status_sync_failed: '同步失败',
    status_rescan_required: '需要重新扫描',
    status_paused: '已暂停',
    status_revoked: '权限已撤销',
    status_deleted: '已删除',
    status_parse_failed: '解析失败',
    status_parsed: '已解析 · 待确认',
    status_queued: '排队中',
    status_running: '进行中',
    status_completed: '已完成',
    status_failed: '失败',
    status_stale: '依据已变化',
    stage_parse: '解析',
    stage_extract: '提取',
    stage_recommend: '生成建议',
    stage_complete: '完成',
    kind_employee: '员工',
    kind_tool: '工具',
    kind_sop: 'SOP',
    kind_object: '业务对象',
    kind_relation: '对象关系',
    status_outcome_unknown: '结果未知 · 需人工核对',
    reqFailed: '请求失败，请稍后重试。',
    reqFailedHttp: '请求失败（HTTP {status}）',
    evidenceLocator: '版本 {version} · 字符 {start}–{end}',
    evidenceSource: '来源 {sourceId}',
    noEvidence: '没有可定位依据，不能据此生成或采纳建议。',
    scopeMailbox: '邮箱',
    scopeFolder: '邮件文件夹',
    scopeReceivedSince: '邮件起始日期',
    scopeDriveId: '文档库',
    scopeFolderPath: '文件夹路径',
    scopeResourceId: '授权资源引用',
    scopeProjects: '授权项目范围',
    scopeNoProjects: '无项目授权',
    importSuccess: '所选资料已导入，仍需逐版本核对并确认。',
    syncSuccess: '来源同步已完成，新资料仍需逐版本确认。',
    readingPreview: '读取范围预览中…',
    previewSourceBtn: '预览来源范围与资料',
    syncSourceBtn: '同步来源',
    previewAria: '{name} 来源元数据预览',
    previewHeading: '来源元数据预览',
    previewHint1: '预览仅显示允许范围内的标题、版本和定位，不代表正文已获人工确认。导入前服务端会重新核对权限。',
    previewBlocked: '权限受限资料：{count} 份，仅显示数量，不能选择。',
    previewItemMeta: '版本 {version} · {locator}',
    previewEmpty: '当前范围没有可导入资料。',
    importSelectedBtn: '导入所选资料（{count}）',
    confirmConnFirst: '请先独立确认连接，再选择资料导入。',
    closePreviewBtn: '关闭来源预览',
    itemPreviewSummary: '查看当前版本原文与定位',
    itemPreviewLoading: '正在核对源权限并读取…',
    itemPreviewTruncated: '预览达到 200,000 字符上限，请同时核对原始文件。',
    recLockSuccess: '草案已保存并由人工锁定。',
    recDraftKind: '{kind}草案',
    recHumanLocked: '人工锁定',
    recPendingReview: '建议 · 待核对',
    recOriginManual: '人工补充 · 不是文档推断',
    recOriginInferred: '文档推断 · 需核对来源依据',
    recStaleAlert: '依据版本已变化，旧引用已撤回。人工内容保留，请核对新建议后决定是否采纳。',
    recName: '名称',
    recDesc: '说明',
    recSaveLockBtn: '保存并人工锁定',
    recDeleteSuccess: '草案已删除，后续分析不会自动恢复。',
    recDeleteBtn: '删除草案',
    recProposalTitle: '分析提出了修改，尚未覆盖人工内容',
    recAdoptSuccess: '修改已由人工采纳并锁定。',
    recAdoptBtn: '核对后采纳这次修改',
    recManualNoEvidence: '此角色由人工录入，没有文档推断依据。',
    recViewEvidence: '查看依据 · {count} 处',
    connCreatedNotice: '连接已验证，可以选择资料导入。',
    spaceSavedNotice: '知识空间名称已保存，仅更新名称元数据。',
    manualRoleSavedNotice: '人工角色已补充，不会据此自动启用资料分析。',
    uploadSuccessNotice: '资料已提交。解析完成后仍需确认当前版本。',
    errDocRead: '无法读取文档文件。',
    pageTitle: '企业知识',
    mcpTitle: '通过 MCP 读取知识',
    mcpHint: '在支持 Streamable HTTP 的客户端中配置 Super Agent 的 Entra 访问令牌，即可搜索和读取你有权限访问的已确认资料。',
    loadingBtn: '读取中…',
    refreshBtn: '刷新状态',
    introMain: '从可信来源建立依据，让每一条建议都能回到原文。',
    loadingState: '正在读取来源与知识状态…',
    step3Cta: '开始分析',
    sec1Title: '知识来源',
    sec1Sub: '配置来源后，可选择要导入知识库的资料。',
    pluginsAria: '来源插件目录',
    badgePaused: '已暂停',
    capsFallback: '能力以服务端为准',
    pausePluginBtn: '暂停{name}',
    enablePluginBtn: '启用{name}',
    pluginPausedNotice: '插件已暂停，来源数据保持不变。',
    pluginEnabledNotice: '插件已启用，请核对来源连接。',
    configureCardBtn: '配置连接',
    hideConfigBtn: '收起表单',
    confirmConnBtn: '确认连接',
    retestConfirmBtn: '重新测试并确认连接',
    connConfirmedNotice: '连接已确认，资料仍需逐版本确认。',
    retestConnBtn: '重新测试连接',
    connRetestedNotice: '连接已重新测试并确认，资料仍需逐版本确认。',
    noConnections: '还没有外部来源连接。',
    connFormTitle: '配置{name}连接',
    connNameLabel: '连接名称',
    connNamePlaceholder: '例如：团队操作资料',
    approvedResourceLabel: '已批准的来源资源',
    noApprovedResource: '暂无已批准的来源资源',
    needAdminScope: '请由管理员批准来源范围后再创建连接。',
    readOnlyAckLabel: '我已核对来源范围，并确认仅以只读方式接入',
    connFormHint: '默认读者为当前用户。连接只读；确认操作不能覆盖来源权限和项目范围。需要额外授权的来源由服务端校验。',
    creatingConn: '验证中…',
    createConnBtn: '验证并连接',
    sec2Title: '资料',
    itemNameLabel: '资料名称',
    itemNamePlaceholder: '操作手册.md',
    itemTextLabel: '文本内容',
    itemTextPlaceholder: '也可以在此粘贴纯文本…',
    submitting: '提交中…',
    submitMaterialBtn: '提交资料',
    parseJobsAria: '文档解析任务',
    parseJobsTitle: '文档解析任务',
    jobUnknownHint: '请人工核对云端任务和文件状态，再决定后续处理。',
    versionMeta: '版本 {version} · {locator}',
    itemStatusPending: '尚未确认用于检索',
    badgeUnavailable: '不可用',
    confirmItemTitle: '核对原始资料后确认版本 {version}',
    confirmItemSuccess: '当前资料版本已确认；是否可用仍由源权限决定。',
    confirmItemBtn: '确认此版本',
    secSearchTitle: '有依据地查询',
    secSearchSub: '权限未知、未确认、已撤销或过期版本不应进入结果。',
    searchLabel: '查询企业资料',
    searchPlaceholder: '输入需要查证的问题或关键词',
    searchingBtn: '查询中…',
    searchBtn: '查询依据',
    searchFoundDefault: '已找到以下来源依据。',
    searchNoHits: '没有当前可用的依据。请确认来源版本、访问权限，或调整关键词。',
    searchIdleHint: '回答和引用来自服务端实际检索结果；没有依据时不生成结论。',
    sec3Title: '知识分析与建议草案',
    sec3Sub: '员工、工具、SOP 与业务对象仅形成草案，需人工决定后续操作。',
    analyzingBtn: '分析进行中',
    startAnalysisBtn: '开始分析',
    analysisSubmittedNotice: '分析任务已提交，进度以服务端状态为准。',
    needConfirmedHint: '请先确认至少一份有权限的资料版本。',
    noAnalyses: '尚未运行分析。分析开始前会再次检查来源权限和版本。',
    noRecommendations: '暂无建议草案。只有带当前有效引用的分析结果才会出现在这里。',
    advancedSummary: '高级',
    advancedHint: '知识空间改名、只读数据库来源、人工补充角色',
    spaceFormAria: '知识空间命名',
    spaceNameLabel: '知识空间名称',
    saveSpaceBtn: '保存知识空间名称',
    spaceNameHint: '仅更新空间名称元数据，不复制数据库或改变来源范围。',
    manualRoleAria: '人工补充角色',
    manualRoleTitle: '人工补充角色',
    manualRoleHint: '直接记录人工已知的角色，标注为人工补充；不会伪装成文档推断，也不会替代来源版本确认。',
    manualRoleNameLabel: '人工角色名称',
    manualRoleDescLabel: '人工角色说明',
    addManualRoleBtn: '添加人工角色',
    retryLoadBtn: '重试读取知识状态',
  },
} satisfies Dict<string>;

type TextKey = keyof typeof TEXT.en;
type Translate = (key: TextKey, vars?: Record<string, string | number>) => string;

const STATUS_KEYS: Record<string, TextKey> = {
  draft: 'status_draft', ready: 'status_ready', confirmed: 'status_confirmed', pending: 'status_pending',
  needs_auth: 'status_needs_auth', needs_reauth: 'status_needs_reauth', sync_failed: 'status_sync_failed',
  rescan_required: 'status_rescan_required', paused: 'status_paused', revoked: 'status_revoked',
  deleted: 'status_deleted', parse_failed: 'status_parse_failed', parsed: 'status_parsed',
  queued: 'status_queued', running: 'status_running', completed: 'status_completed',
  failed: 'status_failed', stale: 'status_stale', outcome_unknown: 'status_outcome_unknown',
  parse: 'stage_parse', extract: 'stage_extract', recommend: 'stage_recommend', complete: 'stage_complete',
  employee: 'kind_employee', tool: 'kind_tool', sop: 'kind_sop', object: 'kind_object', relation: 'kind_relation',
};

const CARD_ORDER = ['local-file', 'mcp', 'database', 'email', 'sharepoint'] as const;

function EvidenceList({ evidence, t }: { evidence: Evidence[]; t: Translate }) {
  return evidence.length ? <ol className="knowledge-evidence">
    {evidence.map((entry, index) => <li key={`${entry.sourceId}:${entry.version}:${entry.start}:${index}`}>
      <blockquote>{entry.quote}</blockquote>
      <p>{entry.locator} <span>· {t('evidenceLocator', { version: entry.version, start: entry.start, end: entry.end })}</span></p>
      <small>{t('evidenceSource', { sourceId: entry.sourceId })}</small>
    </li>)}
  </ol> : <p className="knowledge-empty">{t('noEvidence')}</p>;
}

function ScopeSummary({ scope, projectIds, t }: { scope: SourceScope; projectIds?: string[]; t: Translate }) {
  const projects = projectIds ?? scope.projectIds;
  return <dl className="knowledge-scope">
    {scope.mailbox ? <div><dt>{t('scopeMailbox')}</dt><dd>{scope.mailbox}</dd></div> : null}
    {scope.folder ? <div><dt>{t('scopeFolder')}</dt><dd>{scope.folder}</dd></div> : null}
    {scope.receivedSince ? <div><dt>{t('scopeReceivedSince')}</dt><dd>{scope.receivedSince}</dd></div> : null}
    {scope.driveId ? <div><dt>{t('scopeDriveId')}</dt><dd>{scope.driveId}</dd></div> : null}
    {scope.folderPath ? <div><dt>{t('scopeFolderPath')}</dt><dd>{scope.folderPath}</dd></div> : null}
    {scope.mcpResourceCount !== undefined ? <div><dt>{t('mcpResources')}</dt><dd>{scope.mcpResourceCount}</dd></div> : null}
    {scope.resourceId ? <div><dt>{t('scopeResourceId')}</dt><dd>{scope.resourceId}</dd></div> : null}
    {projects ? <div><dt>{t('scopeProjects')}</dt><dd>{projects.join('、') || t('scopeNoProjects')}</dd></div> : null}
  </dl>;
}

function RemoteSourcePreview({ connection, resource, active, disabled, onAction, request, errorMessage, t }: {
  connection: Connection; resource?: SourceResource; active: boolean; disabled: boolean;
  onAction: (key: string, path: string, body: unknown, success: string) => Promise<boolean>;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  errorMessage: (error: unknown) => string;
  t: Translate;
}) {
  const [preview, setPreview] = useState<ConnectionPreview | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const sequence = useRef(0);
  const scopeKey = JSON.stringify({ scope: resource?.scope, projects: resource?.projectIds, connectionScope: connection.scope });
  useEffect(() => { sequence.current++; setPreview(null); setSelectedIds([]); setError(''); setReading(false); return () => { sequence.current++; }; }, [connection.id, connection.status, active, scopeKey]);
  async function read() {
    if (!active || disabled) return;
    const current = ++sequence.current;
    setReading(true); setError(''); setPreview(null); setSelectedIds([]);
    try {
      const value = await request<ConnectionPreview>(`/connections/${encodeURIComponent(connection.id)}/preview`);
      if (current === sequence.current) setPreview(value);
    } catch (caught) { if (current === sequence.current) setError(errorMessage(caught)); }
    finally { if (current === sequence.current) setReading(false); }
  }
  async function importSelected() {
    if (!active || disabled || !selectedIds.length || connection.status !== 'confirmed') return;
    const ids = [...selectedIds];
    if (await onAction(`import:${connection.id}`, `/connections/${encodeURIComponent(connection.id)}/import`, { ids }, t('importSuccess'))) { setPreview(null); setSelectedIds([]); }
  }
  return <div className="knowledge-remote-source">
    <ScopeSummary scope={{ ...resource?.scope, ...connection.scope }} projectIds={resource?.projectIds} t={t} />
    <div className="knowledge-actions">
      <button className="btn" type="button" disabled={disabled || !active || reading} onClick={() => void read()}>{reading ? t('readingPreview') : t('previewSourceBtn')}</button>
      {connection.status === 'confirmed' ? <button className="btn" type="button" disabled={disabled || !active} onClick={() => void onAction(`sync:${connection.id}`, `/connections/${encodeURIComponent(connection.id)}/sync`, {}, t('syncSuccess'))}>{t('syncSourceBtn')}</button> : null}
    </div>
    {error ? <p className="knowledge-alert" role="alert">{error}</p> : null}
    {preview ? <section className="knowledge-preview" aria-label={t('previewAria', { name: connection.name })}>
      <h3>{t('previewHeading')}</h3><ScopeSummary scope={{ ...resource?.scope, ...preview.scope }} projectIds={resource?.projectIds} t={t} />
      <p className="helper">{t('previewHint1')}</p>
      <p className="helper">{t('previewBlocked', { count: preview.blocked })}</p>
      {preview.items.length ? <ul className="knowledge-preview-items">{preview.items.map(item => <li key={item.id}>
        <label className="knowledge-check"><input type="checkbox" disabled={disabled || !active || connection.status !== 'confirmed'} checked={selectedIds.includes(item.id)} onChange={event => setSelectedIds(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} /><span>{item.title}<small>{t('previewItemMeta', { version: item.version, locator: item.locator })}</small></span></label>
      </li>)}</ul> : <p className="knowledge-empty">{t('previewEmpty')}</p>}
      <button className="btn" type="button" disabled={disabled || !active || connection.status !== 'confirmed' || !selectedIds.length} onClick={() => void importSelected()}>{t('importSelectedBtn', { count: selectedIds.length })}</button>
      {connection.status !== 'confirmed' ? <p className="helper">{t('confirmConnFirst')}</p> : null}
      <button className="btn" type="button" onClick={() => { setPreview(null); setSelectedIds([]); }}>{t('closePreviewBtn')}</button>
    </section> : null}
  </div>;
}

function ItemPreview({ item, request, errorMessage, t }: {
  item: Item;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  errorMessage: (error: unknown) => string;
  t: Translate;
}) {
  const [preview, setPreview] = useState<{ chunks: { text: string; locator: string }[]; truncated: boolean } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function read() {
    setLoading(true); setError('');
    try { setPreview(await request(`/items/${encodeURIComponent(item.id)}/preview?version=${encodeURIComponent(item.version)}`)); }
    catch (caught) { setPreview(null); setError(errorMessage(caught)); } finally { setLoading(false); }
  }
  return <details className="knowledge-item-preview"><summary onClick={() => { if (!preview && !loading) void read(); }}>{t('itemPreviewSummary')}</summary>
    {loading ? <p role="status">{t('itemPreviewLoading')}</p> : null}
    {error ? <p className="knowledge-alert" role="alert">{error}</p> : null}
    {preview ? <>{preview.chunks.map((c, n) => <div key={n}><small>{c.locator}</small><blockquote>{c.text}</blockquote></div>)}{preview.truncated ? <p className="helper">{t('itemPreviewTruncated')}</p> : null}</> : null}
  </details>;
}

function RecommendationCard({ recommendation: r, disabled, onAction, label, t }: {
  recommendation: Recommendation; disabled: boolean;
  onAction: (key: string, path: string, body: unknown, success: string) => Promise<boolean>;
  label: (value: string) => string;
  t: Translate;
}) {
  const [name, setName] = useState(r.name);
  const [description, setDescription] = useState(r.description);
  useEffect(() => { setName(r.name); setDescription(r.description); }, [r.name, r.description]);
  async function save(event: FormEvent) {
    event.preventDefault();
    await onAction(`lock:${r.id}`, `/recommendations/${encodeURIComponent(r.id)}/lock`, { name: name.trim(), description: description.trim() }, t('recLockSuccess'));
  }
  return <article className="knowledge-recommendation">
    <div className="knowledge-row">
      <span className="knowledge-kind">{t('recDraftKind', { kind: label(r.kind) })}</span>
      <span className={`knowledge-badge ${r.humanLocked ? 'is-gold' : ''}`}>{r.humanLocked ? t('recHumanLocked') : t('recPendingReview')}</span>
    </div>
    <p className="helper">{r.origin === 'manual' ? t('recOriginManual') : t('recOriginInferred')}</p>
    {r.stale ? <p className="knowledge-alert">{t('recStaleAlert')}</p> : null}
    {r.relation ? <p className="helper">{r.relation.from} → {r.relation.to} · {r.relation.label}</p> : null}
    <form onSubmit={save} className="knowledge-form">
      <label className="field"><span>{t('recName')}</span><input required maxLength={160} value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="field"><span>{t('recDesc')}</span><textarea required maxLength={4000} rows={3} value={description} onChange={event => setDescription(event.target.value)} /></label>
      <div className="knowledge-actions">
        <button className="btn" disabled={disabled || !name.trim() || !description.trim() || (r.origin !== 'manual' && !r.evidence.length)}>{t('recSaveLockBtn')}</button>
        <button className="btn knowledge-danger" type="button" disabled={disabled} onClick={() => void onAction(`delete:${r.id}`, `/recommendations/${encodeURIComponent(r.id)}/delete`, {}, t('recDeleteSuccess'))}>{t('recDeleteBtn')}</button>
      </div>
    </form>
    {r.proposedChange ? <div className="knowledge-proposal">
      <strong>{t('recProposalTitle')}</strong>
      <p>{r.proposedChange.name}</p><p>{r.proposedChange.description}</p>
      {r.proposedChange.evidence ? <EvidenceList evidence={r.proposedChange.evidence} t={t} /> : null}
      <button className="btn" type="button" disabled={disabled} onClick={() => void onAction(`adopt:${r.id}`, `/recommendations/${encodeURIComponent(r.id)}/adopt`, {}, t('recAdoptSuccess'))}>{t('recAdoptBtn')}</button>
    </div> : null}
    {r.origin === 'manual' ? <p className="helper">{t('recManualNoEvidence')}</p> : <details><summary>{t('recViewEvidence', { count: r.evidence.length })}</summary><EvidenceList evidence={r.evidence} t={t} /></details>}
  </article>;
}

export function KnowledgePage() {
  const t = useT(TEXT);
  const [lang] = useLang();
  const pluginDisplay = (plugin: Plugin) => (lang === 'en' ? ENGLISH_PLUGINS[plugin.id] : undefined) ?? plugin;
  const pluginName = (id: string, catalog: Plugin[]) => {
    const plugin = catalog.find(entry => entry.id === id);
    return plugin ? pluginDisplay(plugin).name : id;
  };
  const label = (value: string) => {
    const key = STATUS_KEYS[value];
    return key ? t(key) : value;
  };
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : t('reqFailed');

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await api<T & { message?: string; error?: string }>(ROOT + path, init);
    if (response.status < 200 || response.status >= 300 || response.body.error) {
      if (response.body.error === 'workbook_unreadable') throw new Error(t('errUnreadableWorkbook'));
      if (response.body.error === 'unsupported_file' || response.body.error === 'unreadable_file') throw new Error(t('errUnreadableFile'));
      if (response.status === 413 || response.body.error === 'text_too_large') throw new Error(t('errTooLarge'));
      const mcpErrors: Record<string, TextKey> = {
        mcp_invalid_url: 'mcpInvalidUrl', mcp_auth_required: 'mcpAuthRequired',
        mcp_no_resources: 'mcpNoResources', mcp_connection_failed: 'mcpConnectionFailed',
      };
      const mcpError = response.body.error && mcpErrors[response.body.error];
      if (mcpError) throw new Error(t(mcpError));
      if (response.body.error === 'connection_test_failed') throw new Error(t('connectionTestFailed'));
      throw new Error((lang === 'zh' ? response.body.message : undefined) ?? t('reqFailedHttp', { status: response.status }));
    }
    return response.body;
  }

  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [activeSourceCard, setActiveSourceCard] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fileSubmissions, setFileSubmissions] = useState<FileSubmission[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [connectionName, setConnectionName] = useState('');
  const [mcpEndpoint, setMcpEndpoint] = useState('');
  const [sourceFeedback, setSourceFeedback] = useState<{ text: string; error?: boolean } | null>(null);
  const [resourceId, setResourceId] = useState('');
  const [readOnlyAcknowledged, setReadOnlyAcknowledged] = useState(false);
  const [spaceName, setSpaceName] = useState('');
  const [manualRoleName, setManualRoleName] = useState('');
  const [manualRoleDescription, setManualRoleDescription] = useState('');
  const [uploadName, setUploadName] = useState('');
  const [uploadText, setUploadText] = useState('');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const refreshSequence = useRef(0);
  const actionInFlight = useRef(false);
  const searchSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    setLoading(true);
    try {
      const value = await request<Overview>('/overview');
      if (sequence === refreshSequence.current) { setOverview(value); setError(''); }
    } catch (caught) {
      if (sequence === refreshSequence.current) setError(errorMessage(caught));
    } finally { if (sequence === refreshSequence.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(); return () => { refreshSequence.current++; searchSequence.current++; }; }, [load]);
  useEffect(() => {
    setSpaceName(overview?.spaceName === DEFAULT_SPACE_NAME ? '' : overview?.spaceName ?? '');
  }, [overview?.spaceName]);
  const analysisActive = overview?.analyses.some(run => run.status === 'queued' || run.status === 'running') ?? false;
  const parseJobs = overview?.parseJobs.filter(job => job.status !== 'completed' && job.error !== 'superseded') ?? [];
  const parseActive = parseJobs.some(job => job.status === 'queued' || job.status === 'running');
  const profilesRefining = overview?.items.some(item => item.profile?.refining) ?? false;
  useEffect(() => {
    if (!analysisActive && !parseActive && !profilesRefining) return;
    const interval = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(interval);
  }, [analysisActive, parseActive, profilesRefining, load]);

  const activeCardPlugin = overview?.plugins.find(plugin => plugin.id === activeSourceCard && plugin.enabled);
  const selectedPlugin = activeCardPlugin?.id ?? '';
  const externalConnections = overview?.connections.filter(connection => connection.pluginId !== 'local-file') ?? [];
  const sourceResources = overview?.sourceResources?.filter(resource => resource.pluginId === selectedPlugin) ?? [];
  const selectedResource = sourceResources.find(resource => resource.id === resourceId) ?? sourceResources[0];
  const databasePlugin = overview?.plugins.find(plugin => plugin.id === 'database');
  const databaseEnabled = !!databasePlugin?.enabled;
  const canUpload = !!overview?.canConfirm && overview.plugins.some(plugin => plugin.id === 'local-file' && plugin.enabled);
  const confirmedCount = overview?.items.filter(item => item.confirmed).length ?? 0;
  const recommendations = overview?.recommendations.filter(recommendation => !recommendation.deleted) ?? [];
  const selectedResourceScope = JSON.stringify({ scope: selectedResource?.scope, projects: selectedResource?.projectIds });
  useEffect(() => { setReadOnlyAcknowledged(false); }, [selectedPlugin, selectedResource?.id, selectedResourceScope]);

  const orderedPlugins = [...(overview?.plugins ?? [])].sort((a, b) => {
    const ai = CARD_ORDER.indexOf(a.id as typeof CARD_ORDER[number]);
    const bi = CARD_ORDER.indexOf(b.id as typeof CARD_ORDER[number]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  async function action(key: string, path: string, body: unknown, success: string, method = 'POST'): Promise<boolean> {
    if (actionInFlight.current) return false;
    actionInFlight.current = true;
    const forSources = path.startsWith('/connections') || path.startsWith('/plugins');
    setBusy(key); setNotice(''); setError('');
    if (forSources) setSourceFeedback(null);
    try {
      await request(path, { method, body: JSON.stringify(body) });
      if (forSources) setSourceFeedback({ text: success });
      else setNotice(success);
      searchSequence.current++; setSearchResult(null); setSearchError(''); setSearching(false);
      await load();
      return true;
    } catch (caught) {
      if (forSources) setSourceFeedback({ text: errorMessage(caught), error: true });
      else setError(errorMessage(caught));
      return false;
    }
    finally { actionInFlight.current = false; setBusy(''); }
  }

  function selectSourceCard(cardId: string) {
    if (cardId === 'database') {
      setActiveSourceCard('database');
      setAdvancedOpen(true);
      window.setTimeout(() => document.getElementById('database-source-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
      return;
    }
    setActiveSourceCard(activeSourceCard === cardId ? null : cardId);
    setResourceId('');
    setReadOnlyAcknowledged(false);
    setSourceFeedback(null);
  }

  async function connectMcp(event: FormEvent) {
    event.preventDefault();
    if (await action('mcp-connection', '/connections/mcp', { endpoint: mcpEndpoint.trim() }, t('connCreatedNotice'))) {
      setMcpEndpoint('');
      setActiveSourceCard(null);
    }
  }

  async function createConnection(event: FormEvent) {
    event.preventDefault();
    if (!selectedPlugin || !selectedResource || !readOnlyAcknowledged) return;
    if (await action('connection', '/connections', { name: connectionName.trim(), pluginId: selectedPlugin, scope: { resourceId: selectedResource.id }, readOnlyAcknowledged: true, verify: true }, t('connCreatedNotice'))) {
      setConnectionName('');
      setReadOnlyAcknowledged(false);
      setActiveSourceCard(null);
    }
  }
  async function renameSpace(event: FormEvent) {
    event.preventDefault();
    await action('space', '/space', { name: spaceName.trim() }, t('spaceSavedNotice'), 'PUT');
  }
  async function addManualRole(event: FormEvent) {
    event.preventDefault();
    if (await action('manual-role', '/manual-roles', { name: manualRoleName.trim(), description: manualRoleDescription.trim() }, t('manualRoleSavedNotice'))) { setManualRoleName(''); setManualRoleDescription(''); }
  }
  async function pasteMaterial(event: FormEvent) {
    event.preventDefault();
    if (await action('paste', '/local-materials', { name: uploadName.trim(), text: uploadText }, t('uploadSuccessNotice'))) {
      setUploadName('');
      setUploadText('');
    }
  }

  async function uploadFiles(files: File[]) {
    if (!files.length || !canUpload || actionInFlight.current) return;
    actionInFlight.current = true;
    setDragging(false);
    setBusy('files');
    setNotice('');
    setError('');
    const submissions: FileSubmission[] = files.map(file => ({ name: file.name, status: 'uploading' }));
    setFileSubmissions(submissions.slice());
    try {
      for (const [index, file] of files.entries()) {
        try {
          if (file.size === 0) throw new Error(t('errUnreadableFile'));
          if (file.size > 20 * 1024 * 1024) throw new Error(t('errTooLarge'));
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => typeof reader.result === 'string'
              ? resolve(reader.result.slice(reader.result.indexOf(',') + 1))
              : reject(new Error(t('errDocRead')));
            reader.onerror = reader.onabort = () => reject(new Error(t('errDocRead')));
            reader.readAsDataURL(file);
          });
          await request('/local-materials', { method: 'POST', body: JSON.stringify({ name: file.name, base64 }) });
          submissions[index] = { name: file.name, status: 'submitted' };
        } catch (caught) {
          submissions[index] = { name: file.name, status: 'failed', error: errorMessage(caught) };
        }
        setFileSubmissions(submissions.slice());
      }
      searchSequence.current++; setSearchResult(null); setSearchError(''); setSearching(false);
      await load();
    } finally {
      actionInFlight.current = false;
      setBusy('');
    }
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    const sequence = ++searchSequence.current;
    setSearching(true); setSearchError(''); setSearchResult(null);
    try {
      const result = await request<SearchResult>(`/search?q=${encodeURIComponent(query.trim())}`);
      if (sequence === searchSequence.current) setSearchResult(result);
    } catch (caught) { if (sequence === searchSequence.current) setSearchError(errorMessage(caught)); }
    finally { if (sequence === searchSequence.current) setSearching(false); }
  }


  return <div className="knowledge-page">
    <header className="page-head knowledge-head">
      <div>
        <h1>{t('pageTitle')}</h1>
        {overview?.spaceName && overview.spaceName !== DEFAULT_SPACE_NAME ? <p className="knowledge-space-name">{overview.spaceName}</p> : null}
      </div>
      <div className="knowledge-actions">
        <button className="btn" type="button" onClick={() => {
          setSourcesOpen(!sourcesOpen);
          if (!sourcesOpen) window.setTimeout(() => document.getElementById('knowledge-sources')?.scrollIntoView({ block: 'nearest' }), 0);
        }} aria-expanded={sourcesOpen} aria-controls="knowledge-sources">{t('manageSources')}</button>
        <button className="btn" type="button" onClick={() => void load()} disabled={loading || !!busy}>{loading ? t('loadingBtn') : t('refreshBtn')}</button>
      </div>
    </header>
    <div className="knowledge-intro"><p>{t('introMain')}</p></div>
    {error ? <div className="knowledge-alert" role="alert">{error}</div> : null}
    {notice ? <div className="knowledge-notice" role="status">{notice}</div> : null}
    {!overview && loading ? <div className="panel knowledge-empty" role="status">{t('loadingState')}</div> : null}
    {overview ? <>
      <section className="panel knowledge-section" aria-labelledby="knowledge-upload-heading">
        <div className="knowledge-section-head">
          <div><h2 id="knowledge-upload-heading">{t('sec2Title')}</h2></div>
          <button className="btn primary" type="button" disabled={!canUpload || !!busy} onClick={() => fileInput.current?.click()}>{t('addMaterials')}</button>
        </div>
        <input ref={fileInput} type="file" multiple hidden aria-label={t('chooseFiles')} disabled={!canUpload || !!busy} onChange={event => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          void uploadFiles(files);
        }} />
        {canUpload ? <>
          <button className={`knowledge-file-drop ${dragging ? 'is-dragging' : ''}`} type="button" disabled={!!busy}
            onClick={() => fileInput.current?.click()}
            onDragOver={event => {
              if (!event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
              if (!busy) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={event => {
              event.preventDefault();
              setDragging(false);
              void uploadFiles(Array.from(event.dataTransfer.files));
            }}>{t('dropFiles')}</button>
          <details className="knowledge-paste">
            <summary>{t('pasteText')}</summary>
            <form onSubmit={pasteMaterial} className="knowledge-form">
              <label className="field"><span>{t('itemNameLabel')}</span><input required maxLength={180} value={uploadName} placeholder={t('itemNamePlaceholder')} onChange={event => setUploadName(event.target.value)} /></label>
              <label className="field"><span>{t('itemTextLabel')}</span><textarea required rows={4} maxLength={200_000} value={uploadText} placeholder={t('itemTextPlaceholder')} onChange={event => setUploadText(event.target.value)} /></label>
              <button className="btn" disabled={!!busy || !uploadName.trim() || !uploadText.trim()}>{busy === 'paste' ? t('submitting') : t('submitMaterialBtn')}</button>
            </form>
          </details>
        </> : <p className="helper">{t('localUploadDisabled')}</p>}
        {fileSubmissions.some(file => file.status !== 'submitted') ? <ul className="knowledge-source-list" aria-label={t('fileResults')} aria-live="polite">
          {fileSubmissions.map((file, index) => file.status === 'submitted' ? null : <li key={index}>
            <div><strong>{file.name}</strong>{file.error ? <small className="knowledge-job-error">{file.error}</small> : null}</div>
            <span className={`knowledge-badge ${file.error ? 'is-warning' : ''}`}>{t(file.error ? 'failedFile' : 'sendingFile')}</span>
          </li>)}
        </ul> : null}

        {parseJobs.length ? <div className="knowledge-parse-jobs" aria-label={t('parseJobsAria')}><h3>{t('parseJobsTitle')}</h3><ul className="knowledge-source-list">{parseJobs.map(job => <li key={job.id}>
          <div><strong>{job.name}</strong>{job.error && job.status === 'failed' ? <small className="knowledge-job-error">{t(job.error === 'auth' || job.error === 'scope' ? 'parseAccessFailed' : 'parseFileFailed')}</small> : null}{job.status === 'outcome_unknown' ? <small className="knowledge-job-error">{t('jobUnknownHint')}</small> : null}</div>
          <span className={`knowledge-badge ${job.status === 'outcome_unknown' || job.status === 'failed' ? 'is-warning' : ''}`}>{label(job.status)}</span>
        </li>)}</ul></div> : null}

        {overview.items.length ? <MaterialReview
          items={overview.items}
          canManage={overview.canConfirm}
          request={request}
          errorMessage={errorMessage}
          disabled={!!busy}
          sourceName={pluginId => pluginName(pluginId, overview.plugins)}
          onChanged={async (message, failure) => { setNotice(message ?? ''); setError(failure ?? ''); searchSequence.current++; setSearchResult(null); setSearchError(''); setSearching(false); await load(); }}
          renderPreview={item => <ItemPreview key={`${item.id}:${item.version}`} item={item} request={request} errorMessage={errorMessage} t={t} />}
        /> : !parseJobs.length && !fileSubmissions.length ? <p className="knowledge-empty">{t('noMaterials')}</p> : null}
      </section>

      <section id="knowledge-sources" className="panel knowledge-section" hidden={!sourcesOpen} aria-labelledby="knowledge-sources-heading">
        <div className="knowledge-section-head"><div><h2 id="knowledge-sources-heading">{t('sec1Title')}</h2><p className="helper">{t('sec1Sub')}</p></div></div>
        <div className="knowledge-plugins knowledge-source-cards" aria-label={t('pluginsAria')}>
          {orderedPlugins.map(plugin => {
            const isSelected = activeSourceCard === plugin.id;
            return <div key={plugin.id} data-testid={`plugin-${plugin.id}`} className={`knowledge-source-card ${isSelected ? 'is-selected' : ''}`}>
              <div className="knowledge-source-card-top">
                <strong>{pluginDisplay(plugin).name}</strong>
                <span className="knowledge-badge">{!plugin.enabled ? t('badgePaused') : plugin.id === 'local-file' ? t('badgeAutomatic') : externalConnections.some(connection => connection.pluginId === plugin.id && connection.status === 'confirmed') ? t('badgeConnected') : t('badgeNeedsSetup')}</span>
              </div>
              <small>{plugin.id === 'local-file' ? t('automaticLocal') : pluginDisplay(plugin).capabilities.join(' · ') || t('capsFallback')}</small>
              <div className="knowledge-source-card-actions">
                {overview.canConfirm && plugin.enabled && plugin.id !== 'local-file' ? <button className="btn" type="button" onClick={() => selectSourceCard(plugin.id)}>{isSelected && plugin.id !== 'database' ? t('hideConfigBtn') : t('configureCardBtn')}</button> : null}
                {overview.canConfirm && (!plugin.enabled || externalConnections.some(connection => connection.pluginId === plugin.id)) ? <button className="btn" type="button" disabled={!!busy} onClick={() => void action(`plugin:${plugin.id}`, `/plugins/${encodeURIComponent(plugin.id)}`, { enabled: !plugin.enabled }, plugin.enabled ? t('pluginPausedNotice') : t('pluginEnabledNotice'))}>{plugin.enabled ? t('pausePluginBtn', { name: pluginDisplay(plugin).name }) : t('enablePluginBtn', { name: pluginDisplay(plugin).name })}</button> : null}
              </div>
            </div>;
          })}
        </div>
        {sourceFeedback ? <div className={sourceFeedback.error ? 'knowledge-alert knowledge-inset' : 'knowledge-notice knowledge-inset'} role={sourceFeedback.error ? 'alert' : 'status'}>{sourceFeedback.text}</div> : null}
        {selectedPlugin === 'mcp' ? <form onSubmit={connectMcp} className="knowledge-form knowledge-inset">
          <h3>{t('connFormTitle', { name: 'MCP' })}</h3>
          <label className="field"><span>{t('mcpEndpointLabel')}</span><input type="url" required maxLength={1000} value={mcpEndpoint} placeholder="https://example.com/mcp" onChange={event => setMcpEndpoint(event.target.value)} /></label>
          <p className="helper">{t('mcpEndpointHint')}</p>
          <button className="btn" disabled={!!busy || !mcpEndpoint.trim()}>{busy === 'mcp-connection' ? t('creatingConn') : t('createConnBtn')}</button>
        </form> : null}

        {activeCardPlugin && ['email', 'sharepoint', 'mcp'].includes(selectedPlugin) && (selectedPlugin !== 'mcp' || sourceResources.length > 0) ? <form onSubmit={createConnection} className="knowledge-form knowledge-inset">
          <h3>{selectedPlugin === 'mcp' ? t('mcpApprovedTitle') : t('connFormTitle', { name: pluginDisplay(activeCardPlugin).name })}</h3>
          <label className="field"><span>{t('connNameLabel')}</span><input required maxLength={160} value={connectionName} placeholder={t('connNamePlaceholder')} onChange={event => setConnectionName(event.target.value)} /></label>
          <label className="field"><span>{t('approvedResourceLabel')}</span><select value={selectedResource?.id ?? ''} disabled={!sourceResources.length || !!busy} onChange={event => { setResourceId(event.target.value); setReadOnlyAcknowledged(false); }}>{!sourceResources.length ? <option value="">{t('noApprovedResource')}</option> : sourceResources.map(resource => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></label>
          {selectedResource ? <ScopeSummary scope={selectedResource.scope} projectIds={selectedResource.projectIds} t={t} /> : <p className="helper">{t('needAdminScope')}</p>}
          <label className="knowledge-check"><input type="checkbox" required checked={readOnlyAcknowledged} onChange={event => setReadOnlyAcknowledged(event.target.checked)} /><span>{t('readOnlyAckLabel')}</span></label>
          <p className="helper">{t('connFormHint')}</p>
          <button className="btn" disabled={!!busy || !selectedPlugin || !connectionName.trim() || !selectedResource || !readOnlyAcknowledged}>{busy === 'connection' ? t('creatingConn') : t('createConnBtn')}</button>
        </form> : null}

        {externalConnections.length ? <ul className="knowledge-source-list">{externalConnections.map(connection => <li key={connection.id}>
          <div><strong>{connection.name}</strong><small>{connection.scope?.publicMcpEndpoint ?? pluginName(connection.pluginId, overview.plugins)}</small></div>
          <span className={`knowledge-badge ${connection.status === 'confirmed' ? 'is-green' : ''}`}>{label(connection.status)}</span>
          {overview.canConfirm && ['draft', 'tested', 'pending_confirmation', 'sync_failed', 'needs_reauth'].includes(connection.status) ? <button className="btn" disabled={!!busy} onClick={() => void action(`confirm:${connection.id}`, `/connections/${encodeURIComponent(connection.id)}/confirm`, {}, t('connConfirmedNotice'))}>{connection.status === 'draft' ? t('confirmConnBtn') : t('retestConfirmBtn')}</button> : null}
          {overview.canConfirm && connection.status === 'confirmed' ? <button className="btn" disabled={!!busy} onClick={() => void action(`confirm:${connection.id}`, `/connections/${encodeURIComponent(connection.id)}/confirm`, {}, t('connRetestedNotice'))}>{t('retestConnBtn')}</button> : null}
          {['email', 'sharepoint', 'mcp'].includes(connection.pluginId) ? <RemoteSourcePreview connection={connection} resource={overview.sourceResources?.find(resource => resource.id === connection.scope?.resourceId)} active={overview.plugins.some(plugin => plugin.id === connection.pluginId && plugin.enabled && plugin.configured)} disabled={!!busy} onAction={action} request={request} errorMessage={errorMessage} t={t} /> : null}
        </li>)}</ul> : <p className="knowledge-empty">{t('noConnections')}</p>}
      </section>

      <section className="panel knowledge-section" aria-labelledby="knowledge-analysis-heading">
        <div className="knowledge-section-head">
          <div><h2 id="knowledge-analysis-heading">{t('sec3Title')}</h2><p className="helper">{t('sec3Sub')}</p></div>
          <button className="btn" disabled={!!busy || analysisActive || !confirmedCount} onClick={() => void action('analysis', '/analyses', {}, t('analysisSubmittedNotice'))}>{busy === 'analysis' ? t('submitting') : analysisActive ? t('analyzingBtn') : t('startAnalysisBtn')}</button>
        </div>
        {!confirmedCount ? <p className="helper">{t('needConfirmedHint')}</p> : null}
        {overview.analyses.length ? <ul className="knowledge-runs">{overview.analyses.slice(-5).reverse().map(run => <li key={run.id}><span className={`knowledge-badge ${run.status === 'completed' ? 'is-green' : ''}`}>{label(run.status)}</span><span>{label(run.stage)}</span><small>{run.id}</small></li>)}</ul> : <p className="knowledge-empty">{t('noAnalyses')}</p>}
        {recommendations.length ? <div className="knowledge-recommendations">{recommendations.map(recommendation => <RecommendationCard key={recommendation.id} recommendation={recommendation} disabled={!!busy} onAction={action} label={label} t={t} />)}</div> : <p className="knowledge-empty">{t('noRecommendations')}</p>}
      </section>

      <section className="panel knowledge-section" aria-labelledby="knowledge-search-heading">
        <div className="knowledge-section-head"><div><h2 id="knowledge-search-heading">{t('secSearchTitle')}</h2><p className="helper">{t('secSearchSub')}</p></div></div>
        <form className="knowledge-search-form" onSubmit={search}><label className="field"><span>{t('searchLabel')}</span><input required maxLength={200} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('searchPlaceholder')} /></label><button className="btn" disabled={searching || !!busy || !query.trim()}>{searching ? t('searchingBtn') : t('searchBtn')}</button></form>
        {searchError ? <p className="knowledge-alert" role="alert">{searchError}</p> : null}
        {searchResult ? <div className="knowledge-search-result" aria-live="polite">{searchResult.hits.length ? <><p className="knowledge-answer">{searchResult.answer || t('searchFoundDefault')}</p><EvidenceList evidence={searchResult.hits} t={t} /></> : <p className="knowledge-empty">{t('searchNoHits')}</p>}</div> : <p className="helper">{t('searchIdleHint')}</p>}
        <details>
          <summary>{t('mcpTitle')}</summary>
          <p className="helper">{t('mcpHint')}</p>
          <code>{window.location.origin}{ROOT}/mcp</code>
        </details>
      </section>

      <details className="panel knowledge-advanced" open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
        <summary className="knowledge-advanced-summary">
          <strong>{t('advancedSummary')}</strong>
          <span className="helper">{t('advancedHint')}</span>
        </summary>
        <div className="knowledge-advanced-body">
          <form className="knowledge-space-form" aria-label={t('spaceFormAria')} onSubmit={renameSpace}>
            <label className="field"><span>{t('spaceNameLabel')}</span><input required maxLength={160} value={spaceName} placeholder={t('pageTitle')} onChange={event => setSpaceName(event.target.value)} /></label>
            <button className="btn" disabled={!!busy || !spaceName.trim()}>{t('saveSpaceBtn')}</button>
            <p className="helper">{t('spaceNameHint')}</p>
          </form>

          <DatabaseSourcePanel resources={databaseEnabled ? overview.databaseResources ?? [] : []} connections={overview.connections} pluginEnabled={databaseEnabled} onRefresh={load} />

          <form className="knowledge-form knowledge-inset knowledge-manual-role" aria-label={t('manualRoleAria')} onSubmit={addManualRole}>
            <h3>{t('manualRoleTitle')}</h3><p className="helper">{t('manualRoleHint')}</p>
            <label className="field"><span>{t('manualRoleNameLabel')}</span><input required maxLength={160} value={manualRoleName} onChange={event => setManualRoleName(event.target.value)} /></label>
            <label className="field"><span>{t('manualRoleDescLabel')}</span><textarea required rows={3} maxLength={4000} value={manualRoleDescription} onChange={event => setManualRoleDescription(event.target.value)} /></label>
            <button className="btn" disabled={!!busy || !manualRoleName.trim() || !manualRoleDescription.trim()}>{t('addManualRoleBtn')}</button>
          </form>
        </div>
      </details>
    </> : !loading ? <button className="btn" onClick={() => void load()}>{t('retryLoadBtn')}</button> : null}
  </div>;
}
