const $ = id => document.getElementById(id);

const BATCH_STORAGE_KEY = 'deployer-batch-accounts';
let lastBatchLines = [];

const state = {
  loggedIn: false,
  accounts: [],
  zones: [],
  workers: [],
  pages: [],
  kvs: []
};

setRandomNames();
$('uuid').value = crypto.randomUUID();
fillSelect($('accountId'), [], '自动选择第一个账户');
fillSelect($('zoneId'), [], '自动随机子域名');
fillSelect($('quickZone'), [], '无可用域名');
fillProjectSelect();
fillKvSelect();

$('loginButton').addEventListener('click', login);
$('backToLogin').addEventListener('click', () => {
  state.loggedIn = false;
  showPage('login');
  setLoginStatus('已返回登录页');
});
$('quickDeploy').addEventListener('click', () => runDeploy(collectQuickPayload));
$('deploy').addEventListener('click', () => runDeploy(collectAdvancedPayload));

$('newNames').addEventListener('click', setRandomNames);

$('newUuid').addEventListener('click', () => {
  $('uuid').value = crypto.randomUUID();
});

$('bindDomain').addEventListener('change', updateQuickDomainPreview);
$('quickZone').addEventListener('change', updateQuickDomainPreview);

$('clearLogs').addEventListener('click', () => {
  $('logs').textContent = '';
});

$('batchDeploy').addEventListener('click', runBatchDeploy);
$('batchMode').addEventListener('change', syncBatchMode);
$('batchCopy').addEventListener('click', copyBatchResults);

const savedBatchAccounts = localStorage.getItem(BATCH_STORAGE_KEY);
if (savedBatchAccounts) {
  $('batchAccounts').value = savedBatchAccounts;
  $('batchRemember').checked = true;
}
syncBatchMode();

$('accountId').addEventListener('change', async () => {
  if ($('accountId').value) await loadResources();
});

$('zoneId').addEventListener('change', () => {
  if (!$('advancedHostname').value.trim()) return;
  const zone = state.zones.find(item => item.id === $('zoneId').value);
  if (zone && $('advancedHostname').value.trim().split('.').length <= 2) $('advancedHostname').value = zone.name;
});

$('deployMode').addEventListener('change', syncModeState);

$('existingProject').addEventListener('change', () => {
  const selected = parseProjectValue($('existingProject').value);
  if (!selected) return;
  $('deployMode').value = 'update';
  $('deployType').value = selected.type;
  $('projectName').value = selected.name;
  syncModeState();
  setResult(`已选择 ${selected.type === 'pages' ? 'Pages' : 'Worker'} 项目，更新模式只同步代码`, 'success');
});

$('kvId').addEventListener('change', () => {
  const selected = state.kvs.find(item => item.id === $('kvId').value);
  if (selected) $('kvTitle').value = selected.title || '';
});

$('loadAccounts').addEventListener('click', async () => {
  setResult('刷新 Cloudflare 账户和域名中...');
  setBusy(true);
  try {
    await loadCloudflareBase();
    setResult('账户和域名读取完成', 'success');
    if ($('accountId').value) await loadResources();
  } catch (error) {
    setResult(error.message, 'error');
    log(`错误: ${error.message}`);
  } finally {
    setBusy(false);
  }
});

$('loadResources').addEventListener('click', async () => {
  setBusy(true);
  try {
    await loadResources();
  } catch (error) {
    setResult(error.message, 'error');
    log(`错误: ${error.message}`);
  } finally {
    setBusy(false);
  }
});

async function login() {
  setLoginStatus('登录中...');
  setBusy(true);
  try {
    await loadCloudflareBase();
    state.loggedIn = true;
    showPage('deploy');
    setLoginStatus('登录成功', 'success');
    setResult('已登录，可以一键部署', 'success');
  } catch (error) {
    setLoginStatus(error.message, 'error');
    log(`登录失败: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function loadCloudflareBase() {
  const credentials = getCredentials();
  const [accountsRes, zonesRes] = await Promise.all([
    post('/api/accounts', { credentials }),
    post('/api/zones', { credentials })
  ]);
    state.accounts = accountsRes.accounts || [];
    state.zones = zonesRes.zones || [];
    fillSelect($('accountId'), state.accounts, '自动选择第一个账户');
    fillSelect($('zoneId'), state.zones, '自动随机子域名');
    fillSelect($('quickZone'), state.zones, state.zones.length ? '不绑定域名' : '无可用域名');
    updateQuickDomainPreview();
    log(`账户数量: ${state.accounts.length}`);
  log(`可用 Zone: ${state.zones.length}`);
}

async function runDeploy(collector) {
  if (!state.loggedIn) {
    setResult('请先登录', 'error');
    showPage('login');
    return;
  }
  setResult('部署中...');
  setBusy(true);
  try {
    const payload = collector();
    const result = await post('/api/deploy', payload);
    (result.logs || []).forEach(log);
    const url = formatDeployResult(payload, result);
    setResult(url, 'success');
  } catch (error) {
    setResult(error.message, 'error');
    log(`错误: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

function formatDeployResult(payload, result) {
  if (payload.deployMode === 'update') return `${result.projectName} 代码同步完成`;
  const 地址 = result.domain?.hostname ? `https://${result.domain.hostname}/login` : `${result.projectName}.pages.dev/login`;
  return `${地址} 部署完成，登录密码(ADMIN): ${result.admin}，节点 UUID: ${result.uuid}`;
}

async function runBatchDeploy() {
  const accounts = parseAccounts($('batchAccounts').value);
  if (!accounts.length) {
    setBatchResult('账号列表为空或格式无效（每行：邮箱:GlobalAPIKey）', 'error');
    return;
  }
  const updating = $('batchMode').value === 'update';
  const deployType = $('batchDeployType').value;
  const projectName = $('batchProjectName').value.trim();
  if (updating && !projectName) {
    setBatchResult('批量更新需要填写所有账号共用的项目名', 'error');
    return;
  }
  if ($('batchRemember').checked) localStorage.setItem(BATCH_STORAGE_KEY, $('batchAccounts').value);
  else localStorage.removeItem(BATCH_STORAGE_KEY);

  const independent = $('batchIndependent').checked;
  const shared = {};
  if (!independent) {
    for (const [id, field] of [['batchUuid', 'uuid'], ['batchAdmin', 'admin'], ['batchKey', 'key']]) {
      const value = $(id).value.trim();
      if (value) shared[field] = value;
    }
  }

  lastBatchLines = [];
  const summary = [];
  let done = 0;
  setBusy(true);
  log(`批量任务开始：${accounts.length} 个账号，${updating ? '更新代码' : '新部署'}（${deployType}）`);
  try {
    for (const group of chunk(accounts, 3)) {
      await Promise.all(group.map(async account => {
        const payload = {
          credentials: { email: account.email, key: account.key },
          deployType,
          projectName: updating ? projectName : (projectName || randomName('edge'))
        };
        if (updating) {
          payload.deployMode = 'update';
        } else {
          payload.kvTitle = randomName('store');
          Object.assign(payload, shared);
          if (deployType === 'worker') payload.enableWorkersDev = $('batchWorkersDev').checked;
        }
        try {
          const result = await post('/api/deploy', payload);
          const line = updating
            ? `${result.projectName} 代码同步完成`
            : `${batchUrl(result, deployType)} 部署完成`;
          const detail = updating ? '' : ` ADMIN:${result.admin} UUID:${result.uuid}`;
          summary.push({ ok: true, email: account.email });
          lastBatchLines.push(updating
            ? `${account.email}|${result.projectName}|已更新`
            : `${batchUrl(result, deployType)}|${result.uuid}|${result.admin}|${result.key}`);
          log(`✅ [${account.email}] ${line}${detail}`);
        } catch (error) {
          summary.push({ ok: false, email: account.email });
          lastBatchLines.push(`${account.email}|失败|${error.message}`);
          log(`❌ [${account.email}] ${error.message}`);
        }
        done += 1;
        const okCount = summary.filter(item => item.ok).length;
        setBatchResult(`批量进行中 ${done}/${accounts.length}：成功 ${okCount}，失败 ${done - okCount}`);
      }));
    }
    const okCount = summary.filter(item => item.ok).length;
    const failCount = accounts.length - okCount;
    setBatchResult(`批量完成：成功 ${okCount}，失败 ${failCount}（详情见日志，可复制结果）`, failCount ? '' : 'success');
    log(`批量任务完成：成功 ${okCount}，失败 ${failCount}`);
  } finally {
    setBusy(false);
    $('batchCopy').disabled = lastBatchLines.length === 0;
  }
}

function parseAccounts(text) {
  const seen = new Set();
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    let email = '';
    let key = '';
    const strict = line.match(/^([^\s:@：]+@[^\s:@：]+)\s*(?:----|:|：|,|，|\s)\s*([A-Za-z0-9_-]{20,})$/);
    if (strict) {
      email = strict[1];
      key = strict[2];
    } else {
      const parts = line.split(/----|:|：|,|，|\s+/).filter(Boolean);
      if (parts.length === 2 && parts[0].includes('@')) {
        email = parts[0];
        key = parts[1];
      }
    }
    if (email && key && !seen.has(email)) {
      seen.add(email);
      out.push({ email, key });
    }
  }
  return out;
}

function chunk(list, size) {
  const groups = [];
  for (let i = 0; i < list.length; i += size) groups.push(list.slice(i, i + size));
  return groups;
}

function batchUrl(result, deployType) {
  if (result.domain?.hostname) return `https://${result.domain.hostname}/login`;
  return deployType === 'worker'
    ? `${result.projectName}（workers.dev 地址见控制台）`
    : `${result.projectName}.pages.dev/login`;
}

function syncBatchMode() {
  const updating = $('batchMode').value === 'update';
  $('batchHint').textContent = updating
    ? '批量更新：按项目名给每个账号同步最新代码，不改动 UUID/ADMIN/KEY/KV/域名；项目不存在的账号计为失败。'
    : '批量新部署：账号并行执行、互不影响；项目名留空则每账号随机；勾选「独立随机」时每账号各自生成 UUID/ADMIN/KEY。';
  for (const id of ['batchUuid', 'batchAdmin', 'batchKey', 'batchIndependent', 'batchWorkersDev']) {
    $(id).disabled = updating;
  }
}

async function copyBatchResults() {
  if (!lastBatchLines.length) return;
  try {
    await navigator.clipboard.writeText(lastBatchLines.join('\n'));
    setBatchResult('结果已复制到剪贴板', 'success');
  } catch {
    setBatchResult('复制失败，请从日志手动复制', 'error');
  }
}

function setBatchResult(text, type = '') {
  $('batchResult').textContent = text;
  $('batchResult').className = `result ${type}`.trim();
}

async function loadResources() {
  const credentials = getCredentials();
  const accountId = $('accountId').value;
  if (!accountId) throw new Error('请先读取并选择 Account');
  setResult('读取现有项目和 KV 中...');
  const resources = await post('/api/resources', { credentials, accountId });
  state.workers = resources.workers || [];
  state.pages = resources.pages || [];
  state.kvs = resources.kvs || [];
  fillProjectSelect();
  fillKvSelect();
  log(`现有 Worker: ${state.workers.length}`);
  log(`现有 Pages: ${state.pages.length}`);
  log(`现有 KV: ${state.kvs.length}`);
  (resources.warnings || []).forEach(warning => log(`提示: ${warning}`));
  setResult('现有项目读取完成', 'success');
}

function getCredentials() {
  const email = $('email').value.trim();
  const key = $('key').value.trim();
  if (!email || !key) throw new Error('请填写 Cloudflare 邮箱和 Global API Key');
  return { email, key };
}

function collectQuickPayload() {
  const selectedZone = state.zones.find(item => item.id === $('quickZone').value) || state.zones[0];
  const shouldBindDomain = $('bindDomain').checked && !!selectedZone;
  const hostname = shouldBindDomain ? randomSubdomain(selectedZone.name) : '';
  return {
    credentials: getCredentials(),
    accountId: $('accountId').value,
    deployMode: 'create',
    deployType: 'pages',
    projectName: randomName('edge'),
    uuid: crypto.randomUUID(),
    kvTitle: randomName('store'),
    hostname,
    zoneId: shouldBindDomain ? selectedZone.id : '',
    autoDomain: false
  };
}

function collectAdvancedPayload() {
  const credentials = getCredentials();
  const deployMode = $('deployMode').value;
  const selectedProject = parseProjectValue($('existingProject').value);
  if (deployMode === 'update') {
    const projectName = $('projectName').value.trim() || selectedProject?.name || '';
    if (!projectName) throw new Error('更新现有项目时必须选择或填写项目名称');
    return {
      credentials,
      accountId: $('accountId').value,
      deployMode,
      deployType: $('deployType').value,
      projectName
    };
  }
  const hostname = $('advancedHostname').value.trim();
  const zoneId = $('zoneId').value;
  if (hostname && !zoneId && state.zones.length) {
    const matched = matchZone(hostname);
    if (matched) $('zoneId').value = matched.id;
  }
  if (hostname && !$('zoneId').value && !hostname.includes('.')) throw new Error('自定义域名需要完整域名或先选择 Zone');
  return {
    credentials,
    accountId: $('accountId').value,
    deployMode,
    deployType: $('deployType').value,
    projectName: $('projectName').value.trim() || randomName('edge'),
    uuid: $('uuid').value.trim() || crypto.randomUUID(),
    admin: $('adminPassword').value.trim(),
    key: $('secretKey').value.trim(),
    kvTitle: $('kvTitle').value.trim() || randomName('store'),
    kvId: $('kvId').value,
    hostname,
    zoneId: $('zoneId').value,
    autoDomain: false,
    enableWorkersDev: $('enableWorkersDev').checked
  };
}

function fillSelect(select, items, emptyLabel) {
  select.innerHTML = '';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = emptyLabel;
  select.append(empty);
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.name} (${item.id})`;
    select.append(option);
  }
  if (items.length === 1) select.value = items[0].id;
}

function fillProjectSelect() {
  const select = $('existingProject');
  select.innerHTML = '';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = state.workers.length || state.pages.length ? '请选择要更新的项目' : '暂无项目，先读取';
  select.append(empty);
  for (const worker of state.workers) appendOption(select, `worker:${worker.name}`, `Worker: ${worker.title || worker.name}`);
  for (const page of state.pages) {
    const kvText = page.kvId ? ` / 已有 KV: ${shortId(page.kvId)}` : '';
    appendOption(select, `pages:${page.name}`, `Pages: ${page.title || page.name}${kvText}`);
  }
}

function fillKvSelect() {
  const select = $('kvId');
  select.innerHTML = '';
  appendOption(select, '', $('deployMode').value === 'update' ? '更新模式不修改 KV' : '新建随机 KV');
  for (const kv of state.kvs) appendOption(select, kv.id, `${kv.title || kv.id} (${kv.id})`);
}

function appendOption(select, value, text) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = text;
  select.append(option);
}

function parseProjectValue(value) {
  if (!value || !value.includes(':')) return null;
  const index = value.indexOf(':');
  return {
    type: value.slice(0, index),
    name: value.slice(index + 1)
  };
}

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `请求失败: ${response.status}`);
  return data;
}

function setRandomNames() {
  $('projectName').value = randomName('edge');
  $('kvTitle').value = randomName('store');
  $('kvId').value = '';
  $('existingProject').value = '';
  $('deployMode').value = 'create';
  updateQuickDomainPreview();
  syncModeState();
}

function updateQuickDomainPreview() {
  const selectedZone = state.zones.find(item => item.id === $('quickZone').value) || state.zones[0];
  if (!$('bindDomain').checked) {
    $('quickHostnamePreview').value = '不绑定域名';
    return;
  }
  if (!selectedZone) {
    $('quickHostnamePreview').value = '账号内没有可用域名';
    return;
  }
  $('quickHostnamePreview').value = randomSubdomain(selectedZone.name);
}

function randomSubdomain(zoneName) {
  return `${randomName('edge')}.${zoneName}`;
}

function randomName(prefix) {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const suffix = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${suffix}`;
}

function shortId(id) {
  return id && id.length > 12 ? `${id.slice(0, 6)}...${id.slice(-6)}` : id;
}

function matchZone(hostname) {
  return state.zones
    .filter(zone => hostname === zone.name || hostname.endsWith(`.${zone.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

function syncModeState() {
  const updating = $('deployMode').value === 'update';
  $('deploy').textContent = updating ? '更新部署' : '高级部署';
  $('modeHint').textContent = updating
    ? '更新模式只同步代码，不创建 KV，不修改 UUID、KV 绑定、域名或 Pages 项目配置。'
    : '新建模式会按表单配置随机 UUID、KV 和可选域名。';
  for (const id of ['uuid', 'kvTitle', 'kvId', 'advancedHostname', 'zoneId', 'enableWorkersDev']) {
    $(id).disabled = updating;
  }
  if ($('kvId').options[0]) $('kvId').options[0].textContent = updating ? '更新模式不修改 KV' : '新建随机 KV';
}

function showPage(page) {
  $('loginPage').classList.toggle('page-hidden', page !== 'login');
  $('deployPage').classList.toggle('page-hidden', page !== 'deploy');
}

function setBusy(busy) {
  for (const button of document.querySelectorAll('button')) button.disabled = busy;
}

function setLoginStatus(text, type = '') {
  $('loginStatus').textContent = text;
  $('loginStatus').className = `result ${type}`.trim();
}

function setResult(text, type = '') {
  $('result').textContent = text;
  $('result').className = `result ${type}`.trim();
}

function log(text) {
  const target = $('logs');
  target.textContent += `${text}\n`;
  target.scrollTop = target.scrollHeight;
}
