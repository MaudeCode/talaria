// Tool activity labels, worklog summaries, list joiners, and "processed for"
// wording per locale. Ported verbatim from the legacy static/i18n.js helper
// block (HWEB-100). These stay code rather than Paraglide messages because
// they compose grammar from tables with count-free fallbacks.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/restrict-plus-operands */
export type ToolActionState = 'running' | 'done'
export type ToolKind = 'shell' | 'read' | 'list' | 'search' | 'web' | 'write' | 'skill' | 'memory' | 'delegate' | 'unknown' | (string & {})

const _I18N_TOOL_ACTION_TEXT_EN: any = {
    shell: { running: 'Running', done: 'Ran', fail: 'run', fallback: 'a command' },
    read: { running: 'Reading', done: 'Read', fail: 'read', fallback: 'a file' },
    list: { running: 'Listing', done: 'Listed', fail: 'list', fallback: 'files' },
    search: { running: 'Searching', done: 'Searched', fail: 'search', fallback: 'workspace' },
    web: { running: 'Checking', done: 'Checked', fail: 'check', fallback: 'web data' },
    write: { running: 'Editing', done: 'Edited', fail: 'edit', fallback: 'a file' },
    skill: { running: 'Loading', done: 'Loaded', fail: 'load', fallback: 'a skill' },
    memory: { running: 'Saving', done: 'Saved', fail: 'save', fallback: 'memory' },
    delegate: { running: 'Delegating', done: 'Delegated', fail: 'delegate', fallback: 'a task' },
    unknown: { running: 'Running', done: 'Ran', fail: 'run', fallback: 'a tool' },
};
const _I18N_TOOL_SUMMARY_TEXT_EN: any = {
    shell: { running: ['Running a command', 'Running commands'], done: ['Ran a command', 'Ran commands'] },
    read: { running: ['Reading a file', 'Reading files'], done: ['Read a file', 'Read files'] },
    list: { running: ['Listing files', 'Listing files'], done: ['Listed files', 'Listed files'] },
    search: { running: ['Searching workspace', 'Searching workspace'], done: ['Searched workspace', 'Searched workspace'] },
    web: { running: ['Searching the web', 'Searching the web'], done: ['Searched the web', 'Searched the web'] },
    write: { running: ['Editing a file', 'Editing files'], done: ['Edited a file', 'Edited files'] },
    skill: { running: ['Loading a tool', 'Loading tools'], done: ['Loaded a tool', 'Loaded tools'] },
    memory: { running: ['Saving memory', 'Saving memory'], done: ['Saved memory', 'Saved memory'] },
    delegate: { running: ['Delegating a task', 'Delegating tasks'], done: ['Delegated a task', 'Delegated tasks'] },
    unknown: { running: ['Calling a tool', 'Calling tools'], done: ['Called a tool', 'Called tools'] },
};
const _I18N_TOOL_ACTION_TEXT_RU: any = {
    shell: { running: 'Выполняю', done: 'Выполнена', fail: 'выполнить', fallback: 'команду' },
    read: { running: 'Читаю', done: 'Прочитан', fail: 'прочитать', fallback: 'файл' },
    list: { running: 'Показываю список', done: 'Показан список', fail: 'показать список', fallback: 'файлов' },
    search: { running: 'Ищу', done: 'Поиск выполнен', fail: 'найти', fallback: 'в рабочей области' },
    web: { running: 'Проверяю', done: 'Проверено', fail: 'проверить', fallback: 'веб-данные' },
    write: { running: 'Обновляю', done: 'Обновлён', fail: 'обновить', fallback: 'файл' },
    skill: { running: 'Загружаю', done: 'Загружен', fail: 'загрузить', fallback: 'навык' },
    memory: { running: 'Сохраняю', done: 'Сохранена', fail: 'сохранить', fallback: 'память' },
    delegate: { running: 'Делегирую', done: 'Делегировано', fail: 'делегировать', fallback: 'задачу' },
    unknown: { running: 'Выполняю', done: 'Выполнен', fail: 'выполнить', fallback: 'инструмент' },
};
const _I18N_TOOL_SUMMARY_TEXT_RU: any = {
    shell: { running: ['Выполняется команда', 'Выполняются {n} команды', 'Выполняется {n} команд'], done: ['Выполнена команда', 'Выполнены {n} команды', 'Выполнено {n} команд'] },
    read: { running: ['Читается файл', 'Читаются {n} файла', 'Читается {n} файлов'], done: ['Прочитан файл', 'Прочитаны {n} файла', 'Прочитано {n} файлов'] },
    list: { running: ['Показывается список файлов', 'Показываются {n} списка', 'Показывается {n} списков'], done: ['Показан список файлов', 'Показаны {n} списка', 'Показано {n} списков'] },
    search: { running: ['Идёт поиск в рабочей области', 'Идут {n} поиска в рабочей области', 'Идёт {n} поисков в рабочей области'], done: ['Поиск в рабочей области выполнен', 'Выполнены {n} поиска в рабочей области', 'Выполнено {n} поисков в рабочей области'] },
    web: { running: ['Выполняется проверка веба', 'Выполняются {n} проверки веба', 'Выполняется {n} проверок веба'], done: ['Проверка веба выполнена', 'Выполнены {n} проверки веба', 'Выполнено {n} проверок веба'] },
    write: { running: ['Обновляется файл', 'Обновляются {n} файла', 'Обновляется {n} файлов'], done: ['Обновлён файл', 'Обновлены {n} файла', 'Обновлено {n} файлов'] },
    skill: { running: ['Загружается навык', 'Загружаются {n} навыка', 'Загружается {n} навыков'], done: ['Загружен навык', 'Загружены {n} навыка', 'Загружено {n} навыков'] },
    memory: { running: ['Сохраняется память', 'Сохраняются {n} обновления памяти', 'Сохраняется {n} обновлений памяти'], done: ['Память сохранена', 'Сохранены {n} обновления памяти', 'Сохранено {n} обновлений памяти'] },
    delegate: { running: ['Делегируется задача', 'Делегируются {n} задачи', 'Делегируется {n} задач'], done: ['Задача делегирована', 'Делегированы {n} задачи', 'Делегировано {n} задач'] },
    unknown: { running: ['Выполняется инструмент', 'Выполняются {n} инструмента', 'Выполняется {n} инструментов'], done: ['Инструмент выполнен', 'Выполнены {n} инструмента', 'Выполнено {n} инструментов'] },
};
const _I18N_TOOL_SUMMARY_TEXT_RU_COUNT_FREE: any = {
    shell: { running: 'Выполняются команды', done: 'Выполнены команды' },
    read: { running: 'Читаются файлы', done: 'Прочитаны файлы' },
    list: { running: 'Показываются списки файлов', done: 'Показаны списки файлов' },
    search: { running: 'Идут поиски в рабочей области', done: 'Поиски в рабочей области выполнены' },
    web: { running: 'Выполняются проверки веба', done: 'Проверки веба выполнены' },
    write: { running: 'Обновляются файлы', done: 'Обновлены файлы' },
    skill: { running: 'Загружаются навыки', done: 'Загружены навыки' },
    memory: { running: 'Сохраняются обновления памяти', done: 'Сохранены обновления памяти' },
    delegate: { running: 'Делегируются задачи', done: 'Задачи делегированы' },
    unknown: { running: 'Выполняются инструменты', done: 'Инструменты выполнены' },
};
const _I18N_TOOL_ACTION_TEXT_ZH: any = {
    shell: { running: '正在运行', done: '已运行', fail: '运行', fallback: '命令' },
    read: { running: '正在读取', done: '已读取', fail: '读取', fallback: '文件' },
    list: { running: '正在列出', done: '已列出', fail: '列出', fallback: '文件' },
    search: { running: '正在搜索', done: '已搜索', fail: '搜索', fallback: '代码' },
    web: { running: '正在检查', done: '已检查', fail: '检查', fallback: '网页' },
    write: { running: '正在更新', done: '已更新', fail: '更新', fallback: '文件' },
    skill: { running: '正在读取', done: '已读取', fail: '读取', fallback: '技能' },
    memory: { running: '正在保存', done: '已保存', fail: '保存', fallback: '记忆' },
    delegate: { running: '正在委派', done: '已委派', fail: '委派', fallback: '任务' },
    unknown: { running: '正在运行', done: '已运行', fail: '运行', fallback: '工具' },
};
const _I18N_TOOL_SUMMARY_TEXT_ZH: any = {
    shell: { running: ['正在运行命令', '正在运行 {n} 条命令'], done: ['已运行命令', '已运行 {n} 条命令'] },
    read: { running: ['正在读取文件', '正在读取 {n} 个文件'], done: ['已读取文件', '已读取 {n} 个文件'] },
    list: { running: ['正在列出文件', '正在列出 {n} 个项目'], done: ['已列出文件', '已列出 {n} 个项目'] },
    search: { running: ['正在搜索代码', '正在搜索代码 {n} 次'], done: ['已搜索代码', '已搜索代码 {n} 次'] },
    web: { running: ['正在检查网页', '正在检查网页 {n} 次'], done: ['已检查网页', '已检查网页 {n} 次'] },
    write: { running: ['正在更新文件', '正在更新 {n} 个文件'], done: ['已更新文件', '已更新 {n} 个文件'] },
    skill: { running: ['正在读取技能', '正在读取 {n} 个技能'], done: ['已读取技能', '已读取 {n} 个技能'] },
    memory: { running: ['正在保存记忆', '正在保存 {n} 条记忆'], done: ['已保存记忆', '已保存 {n} 条记忆'] },
    delegate: { running: ['正在委派任务', '正在委派 {n} 个任务'], done: ['已委派任务', '已委派 {n} 个任务'] },
    unknown: { running: ['正在运行工具', '正在运行 {n} 个工具'], done: ['已运行工具', '已运行 {n} 个工具'] },
};
const _I18N_TOOL_ACTION_TEXT_ZH_HANT: any = {
    shell: { running: '正在執行', done: '已執行', fail: '執行', fallback: '命令' },
    read: { running: '正在讀取', done: '已讀取', fail: '讀取', fallback: '檔案' },
    list: { running: '正在列出', done: '已列出', fail: '列出', fallback: '檔案' },
    search: { running: '正在搜尋', done: '已搜尋', fail: '搜尋', fallback: '程式碼' },
    web: { running: '正在檢查', done: '已檢查', fail: '檢查', fallback: '網頁' },
    write: { running: '正在更新', done: '已更新', fail: '更新', fallback: '檔案' },
    skill: { running: '正在讀取', done: '已讀取', fail: '讀取', fallback: '技能' },
    memory: { running: '正在儲存', done: '已儲存', fail: '儲存', fallback: '記憶' },
    delegate: { running: '正在委派', done: '已委派', fail: '委派', fallback: '任務' },
    unknown: { running: '正在執行', done: '已執行', fail: '執行', fallback: '工具' },
};
const _I18N_TOOL_SUMMARY_TEXT_ZH_HANT: any = {
    shell: { running: ['正在執行命令', '正在執行 {n} 條命令'], done: ['已執行命令', '已執行 {n} 條命令'] },
    read: { running: ['正在讀取檔案', '正在讀取 {n} 個檔案'], done: ['已讀取檔案', '已讀取 {n} 個檔案'] },
    list: { running: ['正在列出檔案', '正在列出 {n} 個項目'], done: ['已列出檔案', '已列出 {n} 個項目'] },
    search: { running: ['正在搜尋程式碼', '正在搜尋程式碼 {n} 次'], done: ['已搜尋程式碼', '已搜尋程式碼 {n} 次'] },
    web: { running: ['正在檢查網頁', '正在檢查網頁 {n} 次'], done: ['已檢查網頁', '已檢查網頁 {n} 次'] },
    write: { running: ['正在更新檔案', '正在更新 {n} 個檔案'], done: ['已更新檔案', '已更新 {n} 個檔案'] },
    skill: { running: ['正在讀取技能', '正在讀取 {n} 個技能'], done: ['已讀取技能', '已讀取 {n} 個技能'] },
    memory: { running: ['正在儲存記憶', '正在儲存 {n} 條記憶'], done: ['已儲存記憶', '已儲存 {n} 條記憶'] },
    delegate: { running: ['正在委派任務', '正在委派 {n} 個任務'], done: ['已委派任務', '已委派 {n} 個任務'] },
    unknown: { running: ['正在執行工具', '正在執行 {n} 個工具'], done: ['已執行工具', '已執行 {n} 個工具'] },
};
function _i18nProcessedElapsed(prefix?: any, duration?: any) {
  return duration ? `${prefix} ${duration}` : prefix;
}
function _i18nProcessedElapsedEn(duration?: any) {
  return duration ? `Worked for ${duration}` : 'Worked';
}
function _i18nProcessedElapsedRu(duration?: any) {
  return _i18nProcessedElapsed('Обработано', duration);
}
function _i18nProcessedElapsedZh(duration?: any) {
  return _i18nProcessedElapsed('已处理', duration);
}
function _i18nProcessedElapsedZhHant(duration?: any) {
  return _i18nProcessedElapsed('已處理', duration);
}
function _i18nToolActionLabelFromMap(map?: any, kind?: any, state?: any, target?: any, display?: any, failed?: any) {
  const verbs = map[kind] || map.unknown || _I18N_TOOL_ACTION_TEXT_EN.unknown;
  const object = target || verbs.fallback || display || 'tool';
  if (failed) return `Failed to ${verbs.fail || 'run'} ${object}`;
  return `${verbs[state] || verbs.running} ${object}`;
}
function _i18nToolActionLabelEn(kind?: any, state?: any, target?: any, display?: any, failed?: any) {
  return _i18nToolActionLabelFromMap(_I18N_TOOL_ACTION_TEXT_EN, kind, state, target, display, failed);
}
function _i18nToolActionLabelRu(kind?: any, state?: any, target?: any, display?: any, failed?: any) {
  const verbs = _I18N_TOOL_ACTION_TEXT_RU[kind] || _I18N_TOOL_ACTION_TEXT_RU.unknown;
  const object = target || verbs.fallback || display || 'инструмент';
  if (failed) return `Не удалось ${verbs.fail || 'выполнить'} ${object}`;
  return `${verbs[state] || verbs.running} ${object}`;
}
function _i18nToolActionLabelZh(kind?: any, state?: any, target?: any, display?: any, failed?: any) {
  if (failed) {
    const verbs = _I18N_TOOL_ACTION_TEXT_ZH[kind] || _I18N_TOOL_ACTION_TEXT_ZH.unknown;
    return `未能${verbs.fail || '运行'} ${target || verbs.fallback || display || '工具'}`;
  }
  return _i18nToolActionLabelFromMap(_I18N_TOOL_ACTION_TEXT_ZH, kind, state, target, display, failed);
}
function _i18nToolActionLabelZhHant(kind?: any, state?: any, target?: any, display?: any, failed?: any) {
  if (failed) {
    const verbs = _I18N_TOOL_ACTION_TEXT_ZH_HANT[kind] || _I18N_TOOL_ACTION_TEXT_ZH_HANT.unknown;
    return `未能${verbs.fail || '執行'} ${target || verbs.fallback || display || '工具'}`;
  }
  return _i18nToolActionLabelFromMap(_I18N_TOOL_ACTION_TEXT_ZH_HANT, kind, state, target, display, failed);
}
function _i18nToolWorklogSummaryFromMap(map?: any, kind?: any, state?: any, count?: any, countFreeMap?: any) {
  const n = Math.max(1, Number(count) || 1);
  const form = (map[kind] || map.unknown || _I18N_TOOL_SUMMARY_TEXT_EN.unknown)[state] || map.unknown.running;
  const picked = n === 1 ? form[0] : form[1];
  if (!picked.includes('{n}')) return picked.trim();
  const countFree = countFreeMap && (countFreeMap[kind] || countFreeMap.unknown);
  return ((countFree && (countFree[state] || countFree.running)) || form[0]).trim();
}
function _i18nToolWorklogSummaryEn(kind?: any, state?: any, count?: any) {
  return _i18nToolWorklogSummaryFromMap(_I18N_TOOL_SUMMARY_TEXT_EN, kind, state, count);
}
function _i18nToolWorklogSummaryRu(kind?: any, state?: any, count?: any) {
  const n = Math.max(1, Number(count) || 1);
  const form = (_I18N_TOOL_SUMMARY_TEXT_RU[kind] || _I18N_TOOL_SUMMARY_TEXT_RU.unknown)[state]
    || _I18N_TOOL_SUMMARY_TEXT_RU.unknown.running;
  if (n === 1) return form[0];
  const countFree = _I18N_TOOL_SUMMARY_TEXT_RU_COUNT_FREE[kind]
    || _I18N_TOOL_SUMMARY_TEXT_RU_COUNT_FREE.unknown;
  return countFree[state] || countFree.running;
}
function _i18nToolWorklogSummaryZh(kind?: any, state?: any, count?: any) {
  return _i18nToolWorklogSummaryFromMap(_I18N_TOOL_SUMMARY_TEXT_ZH, kind, state, count);
}
function _i18nToolWorklogSummaryZhHant(kind?: any, state?: any, count?: any) {
  return _i18nToolWorklogSummaryFromMap(_I18N_TOOL_SUMMARY_TEXT_ZH_HANT, kind, state, count);
}
function _i18nToolSummaryJoinEn(parts?: any) {
  if (!Array.isArray(parts)) return '';
  return parts.filter(Boolean).map((part, index) => (
    index ? part.charAt(0).toLocaleLowerCase() + part.slice(1) : part
  )).join(', ');
}
function _i18nToolSummaryJoinRu(parts?: any) {
  return Array.isArray(parts) ? parts.filter(Boolean).join(', ') : '';
}
function _i18nToolSummaryJoinCjk(parts?: any) {
  const items = Array.isArray(parts) ? parts.filter(Boolean) : [];
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]}和${items[1]}`;
  return `${items.slice(0, -1).join('、')}和${items[items.length - 1]}`;
}

const _I18N_TOOL_ACTION_TEXT_VI: any = {
    shell: { running: 'Đang chạy', done: 'Đã chạy', fail: 'chạy', fallback: 'lệnh' },
    read: { running: 'Đang đọc', done: 'Đã đọc', fail: 'đọc', fallback: 'tệp' },
    list: { running: 'Đang liệt kê', done: 'Đã liệt kê', fail: 'liệt kê', fallback: 'tệp' },
    search: { running: 'Đang tìm kiếm', done: 'Đã tìm kiếm', fail: 'tìm kiếm', fallback: 'workspace' },
    web: { running: 'Đang kiểm tra', done: 'Đã kiểm tra', fail: 'kiểm tra', fallback: 'dữ liệu web' },
    write: { running: 'Đang cập nhật', done: 'Đã cập nhật', fail: 'cập nhật', fallback: 'tệp' },
    skill: { running: 'Đang tải', done: 'Đã tải', fail: 'tải', fallback: 'kỹ năng' },
    memory: { running: 'Đang lưu', done: 'Đã lưu', fail: 'lưu', fallback: 'bộ nhớ' },
    delegate: { running: 'Đang ủy quyền', done: 'Đã ủy quyền', fail: 'ủy quyền', fallback: 'tác vụ' },
    unknown: { running: 'Đang chạy', done: 'Đã chạy', fail: 'chạy', fallback: 'công cụ' },
};
const _I18N_TOOL_SUMMARY_TEXT_VI: any = {
    shell: { running: ['Đang chạy lệnh', 'Đang chạy {n} lệnh'], done: ['Đã chạy lệnh', 'Đã chạy {n} lệnh'] },
    read: { running: ['Đang đọc tệp', 'Đang đọc {n} tệp'], done: ['Đã đọc tệp', 'Đã đọc {n} tệp'] },
    list: { running: ['Đang liệt kê tệp', 'Đang liệt kê {n} mục'], done: ['Đã liệt kê tệp', 'Đã liệt kê {n} tệp'] },
    search: { running: ['Đang tìm kiếm workspace', 'Đang tìm kiếm workspace {n} lần'], done: ['Đã tìm kiếm workspace', 'Đã tìm kiếm workspace {n} lần'] },
    web: { running: ['Đang kiểm tra web', 'Đang kiểm tra web {n} lần'], done: ['Đã kiểm tra web', 'Đã kiểm tra web {n} lần'] },
    write: { running: ['Đang cập nhật tệp', 'Đang cập nhật {n} tệp'], done: ['Đã cập nhật tệp', 'Đã cập nhật {n} tệp'] },
    skill: { running: ['Đang tải kỹ năng', 'Đang tải {n} kỹ năng'], done: ['Đã tải kỹ năng', 'Đã tải {n} kỹ năng'] },
    memory: { running: ['Đang lưu bộ nhớ', 'Đang lưu {n} cập nhật bộ nhớ'], done: ['Đã lưu bộ nhớ', 'Đã lưu {n} cập nhật bộ nhớ'] },
    delegate: { running: ['Đang ủy quyền tác vụ', 'Đang ủy quyền {n} tác vụ'], done: ['Đã ủy quyền tác vụ', 'Đã ủy quyền {n} tác vụ'] },
    unknown: { running: ['Đang chạy công cụ', 'Đang chạy {n} công cụ'], done: ['Đã chạy công cụ', 'Đã chạy {n} công cụ'] },
};
function _i18nProcessedElapsedVi(duration?: any) {
  return _i18nProcessedElapsed('Đã xử lý', duration);
}
function _i18nToolActionLabelVi(kind?: any, state?: any, target?: any, display?: any, failed?: any) {
  const verbs = _I18N_TOOL_ACTION_TEXT_VI[kind] || _I18N_TOOL_ACTION_TEXT_VI.unknown;
  const object = target || verbs.fallback || display || 'công cụ';
  if (failed) return `Không thể ${verbs.fail || 'chạy'} ${object}`;
  return `${verbs[state] || verbs.running} ${object}`;
}
function _i18nToolWorklogSummaryVi(kind?: any, state?: any, count?: any) {
  return _i18nToolWorklogSummaryFromMap(_I18N_TOOL_SUMMARY_TEXT_VI, kind, state, count);
}

const _I18N_TOOL_ACTION_TEXT_PL: any = {
    shell: { running: 'Uruchamianie', done: 'Uruchomiono', fail: 'uruchomić', fallback: 'polecenie' },
    read: { running: 'Odczytywanie', done: 'Odczytano', fail: 'odczytać', fallback: 'plik' },
    list: { running: 'Listowanie', done: 'Wylistowano', fail: 'wylistować', fallback: 'plik' },
    search: { running: 'Przeszukiwanie', done: 'Przeszukano', fail: 'przeszukać', fallback: 'obszar roboczy' },
    web: { running: 'Sprawdzanie', done: 'Sprawdzono', fail: 'sprawdzić', fallback: 'dane internetowe' },
    write: { running: 'Zapisywanie', done: 'Zapisano', fail: 'zapisać', fallback: 'plik' },
    skill: { running: 'Wczytywanie', done: 'Wczytano', fail: 'wczytać', fallback: 'umiejętność' },
    memory: { running: 'Zapisywanie', done: 'Zapisano', fail: 'zapisać', fallback: 'pamięć' },
    delegate: { running: 'Delegowanie', done: 'Delegowano', fail: 'delegować', fallback: 'zadanie' },
    unknown: { running: 'Uruchamianie', done: 'Uruchomiono', fail: 'uruchomić', fallback: 'narzędzie' },
};
const _I18N_TOOL_SUMMARY_TEXT_PL: any = {
    shell: { running: ['Uruchamianie polecenia', 'Uruchamianie {n} poleceń'], done: ['Uruchomiono polecenie', 'Uruchomiono {n} poleceń'] },
    read: { running: ['Odczytywanie pliku', 'Odczytywanie {n} plików'], done: ['Odczytano plik', 'Odczytano {n} plików'] },
    list: { running: ['Listowanie pliku', 'Listowanie {n} plików'], done: ['Wylistowano plik', 'Wylistowano {n} plików'] },
    search: { running: ['Przeszukiwanie obszaru roboczego', 'Przeszukiwanie {n}-krotne obszaru roboczego'], done: ['Przeszukano obszar roboczy', 'Przeszukano {n}-krotnie obszar roboczy'] },
    web: { running: ['Sprawdzanie stron', 'Sprawdzanie {n} stron'], done: ['Sprawdzono strony', 'Sprawdzono {n} stron'] },
    write: { running: ['Zapisywanie pliku', 'Zapisywanie {n} plików'], done: ['Zapisano plik', 'Zapisano {n} plików'] },
    skill: { running: ['Wczytywanie umiejętności', 'Wczytywanie {n} umiejętności'], done: ['Wczytano umiejętność', 'Wczytano {n} umiejętności'] },
    memory: { running: ['Zapisywanie pamięci', 'Zapisywanie {n} wpisów pamięci'], done: ['Zapisano pamięć', 'Zapisano {n} wpisów pamięci'] },
    delegate: { running: ['Delegowanie zadania', 'Delegowanie {n} zadań'], done: ['Delegowano zadanie', 'Delegowano {n} zadań'] },
    unknown: { running: ['Uruchamianie narzędzia', 'Uruchamianie {n} narzędzi'], done: ['Uruchomiono narzędzie', 'Uruchomiono {n} narzędzi'] },
};
const _I18N_TOOL_SUMMARY_TEXT_PL_COUNT_FREE: any = {
    shell: { running: 'Uruchamianie poleceń', done: 'Uruchomiono polecenia' },
    read: { running: 'Odczytywanie plików', done: 'Odczytano pliki' },
    list: { running: 'Listowanie plików', done: 'Wylistowano pliki' },
    search: { running: 'Wielokrotne przeszukiwanie obszaru roboczego', done: 'Wielokrotnie przeszukano obszar roboczy' },
    web: { running: 'Sprawdzanie stron', done: 'Sprawdzono strony' },
    write: { running: 'Zapisywanie plików', done: 'Zapisano pliki' },
    skill: { running: 'Wczytywanie umiejętności', done: 'Wczytano umiejętności' },
    memory: { running: 'Zapisywanie wpisów pamięci', done: 'Zapisano wpisy pamięci' },
    delegate: { running: 'Delegowanie zadań', done: 'Delegowano zadania' },
    unknown: { running: 'Uruchamianie narzędzi', done: 'Uruchomiono narzędzia' },
};
function _i18nProcessedElapsedPl(duration?: any) {
  return _i18nProcessedElapsed('Przetworzono', duration);
}
function _i18nToolActionLabelPl(kind?: any, state?: any, target?: any, display?: any, failed?: any) {
  const verbs = _I18N_TOOL_ACTION_TEXT_PL[kind] || _I18N_TOOL_ACTION_TEXT_PL.unknown;
  const object = target || verbs.fallback || display || 'narzędzie';
  if (failed) return `Nie udało się ${verbs.fail || 'uruchomić'} ${object}`;
  return `${verbs[state] || verbs.running} ${object}`;
}
function _i18nToolWorklogSummaryPl(kind?: any, state?: any, count?: any) {
  return _i18nToolWorklogSummaryFromMap(
    _I18N_TOOL_SUMMARY_TEXT_PL,
    kind,
    state,
    count,
    _I18N_TOOL_SUMMARY_TEXT_PL_COUNT_FREE,
  );
}
function _i18nToolSummaryJoinPl(parts?: any) {
  return Array.isArray(parts) ? parts.filter(Boolean).join(', ') : '';
}
function _i18nToolSummaryJoinVi(parts?: any) {
  return Array.isArray(parts) ? parts.filter(Boolean).join(', ') : '';
}

// Czech (cs) tool/worklog helpers — Slavic plural forms (1 / few 2-4 / many 5+ handled by _i18nToolWorklogSummaryFromMap's singular/plural split; UI uses n===1 vs plural).
const _I18N_TOOL_ACTION_TEXT_CS: any = {
    shell: { running: 'Spouštění', done: 'Spuštěno', fail: 'spustit', fallback: 'příkaz' },
    read: { running: 'Čtení', done: 'Přečteno', fail: 'přečíst', fallback: 'soubor' },
    list: { running: 'Výpis', done: 'Vypsáno', fail: 'vypsat', fallback: 'soubory' },
    search: { running: 'Prohledávání', done: 'Prohledáno', fail: 'prohledat', fallback: 'pracovní prostor' },
    web: { running: 'Kontrola', done: 'Zkontrolováno', fail: 'zkontrolovat', fallback: 'webová data' },
    write: { running: 'Aktualizace', done: 'Aktualizováno', fail: 'aktualizovat', fallback: 'soubor' },
    skill: { running: 'Načítání', done: 'Načteno', fail: 'načíst', fallback: 'dovednost' },
    memory: { running: 'Ukládání', done: 'Uloženo', fail: 'uložit', fallback: 'paměť' },
    delegate: { running: 'Delegování', done: 'Delegováno', fail: 'delegovat', fallback: 'úkol' },
    unknown: { running: 'Spouštění', done: 'Spuštěno', fail: 'spustit', fallback: 'nástroj' },
};
const _I18N_TOOL_SUMMARY_TEXT_CS: any = {
    shell: { running: ['Spouštění příkazu', 'Spouštění {n} příkazů'], done: ['Spuštěn příkaz', 'Spuštěno {n} příkazů'] },
    read: { running: ['Čtení souboru', 'Čtení {n} souborů'], done: ['Přečten soubor', 'Přečteno {n} souborů'] },
    list: { running: ['Výpis souboru', 'Výpis {n} souborů'], done: ['Vypsán soubor', 'Vypsáno {n} souborů'] },
    search: { running: ['Prohledávání prac. prostoru', 'Prohledávání prac. prostoru {n}×'], done: ['Prohledán prac. prostor', 'Prohledán prac. prostor {n}×'] },
    web: { running: ['Kontrola webu', 'Kontrola webu {n}×'], done: ['Zkontrolován web', 'Zkontrolován web {n}×'] },
    write: { running: ['Aktualizace souboru', 'Aktualizace {n} souborů'], done: ['Aktualizován soubor', 'Aktualizováno {n} souborů'] },
    skill: { running: ['Načítání dovednosti', 'Načítání {n} dovedností'], done: ['Načtena dovednost', 'Načteno {n} dovedností'] },
    memory: { running: ['Ukládání paměti', 'Ukládání {n} záznamů paměti'], done: ['Uložena paměť', 'Uloženo {n} záznamů paměti'] },
    delegate: { running: ['Delegování úkolu', 'Delegování {n} úkolů'], done: ['Delegován úkol', 'Delegováno {n} úkolů'] },
    unknown: { running: ['Spouštění nástroje', 'Spouštění {n} nástrojů'], done: ['Spuštěn nástroj', 'Spuštěno {n} nástrojů'] },
};
const _I18N_TOOL_SUMMARY_TEXT_CS_COUNT_FREE: any = {
    shell: { running: 'Spouštění příkazů', done: 'Spuštěny příkazy' },
    read: { running: 'Čtení souborů', done: 'Přečteny soubory' },
    list: { running: 'Výpis souborů', done: 'Vypsány soubory' },
    search: { running: 'Opakované prohledávání prac. prostoru', done: 'Prac. prostor opakovaně prohledán' },
    web: { running: 'Opakovaná kontrola webu', done: 'Web opakovaně zkontrolován' },
    write: { running: 'Aktualizace souborů', done: 'Aktualizovány soubory' },
    skill: { running: 'Načítání dovedností', done: 'Načteny dovednosti' },
    memory: { running: 'Ukládání záznamů paměti', done: 'Uloženy záznamy paměti' },
    delegate: { running: 'Delegování úkolů', done: 'Delegovány úkoly' },
    unknown: { running: 'Spouštění nástrojů', done: 'Spuštěny nástroje' },
};
function _i18nProcessedElapsedCs(duration?: any) {
  return _i18nProcessedElapsed('Zpracováno', duration);
}
function _i18nToolActionLabelCs(kind?: any, state?: any, target?: any, display?: any, failed?: any) {
  const verbs = _I18N_TOOL_ACTION_TEXT_CS[kind] || _I18N_TOOL_ACTION_TEXT_CS.unknown;
  const object = target || verbs.fallback || display || 'nástroj';
  if (failed) return `Nepodařilo se ${verbs.fail || 'spustit'} ${object}`;
  return `${verbs[state] || verbs.running} ${object}`;
}
function _i18nToolWorklogSummaryCs(kind?: any, state?: any, count?: any) {
  return _i18nToolWorklogSummaryFromMap(
    _I18N_TOOL_SUMMARY_TEXT_CS,
    kind,
    state,
    count,
    _I18N_TOOL_SUMMARY_TEXT_CS_COUNT_FREE,
  );
}
function _i18nToolSummaryJoinCs(parts?: any) {
  return Array.isArray(parts) ? parts.filter(Boolean).join(', ') : '';
}

export interface ToolText {
  actionLabel: (kind: ToolKind, state: ToolActionState, target?: string, display?: string, failed?: boolean) => string
  worklogSummary: (kind: ToolKind, state: ToolActionState, count?: number) => string
  summaryJoin: (parts: string[]) => string
  processedElapsed: (duration?: string) => string
}

const EN_TEXT: ToolText = { actionLabel: _i18nToolActionLabelEn, worklogSummary: _i18nToolWorklogSummaryEn, summaryJoin: _i18nToolSummaryJoinEn, processedElapsed: _i18nProcessedElapsedEn }

const TABLE: Record<string, ToolText> = {
  en: EN_TEXT,
  ru: { actionLabel: _i18nToolActionLabelRu, worklogSummary: _i18nToolWorklogSummaryRu, summaryJoin: _i18nToolSummaryJoinRu, processedElapsed: _i18nProcessedElapsedRu },
  zh: { actionLabel: _i18nToolActionLabelZh, worklogSummary: _i18nToolWorklogSummaryZh, summaryJoin: _i18nToolSummaryJoinCjk, processedElapsed: _i18nProcessedElapsedZh },
  'zh-Hant': { actionLabel: _i18nToolActionLabelZhHant, worklogSummary: _i18nToolWorklogSummaryZhHant, summaryJoin: _i18nToolSummaryJoinCjk, processedElapsed: _i18nProcessedElapsedZhHant },
  vi: { actionLabel: _i18nToolActionLabelVi, worklogSummary: _i18nToolWorklogSummaryVi, summaryJoin: _i18nToolSummaryJoinVi, processedElapsed: _i18nProcessedElapsedVi },
  pl: { actionLabel: _i18nToolActionLabelPl, worklogSummary: _i18nToolWorklogSummaryPl, summaryJoin: _i18nToolSummaryJoinPl, processedElapsed: _i18nProcessedElapsedPl },
  cs: { actionLabel: _i18nToolActionLabelCs, worklogSummary: _i18nToolWorklogSummaryCs, summaryJoin: _i18nToolSummaryJoinCs, processedElapsed: _i18nProcessedElapsedCs },
}

/** Locale-specific tool text; every other locale falls back to English, as the legacy catalogue did. */
export function toolText(locale: string): ToolText {
  return TABLE[locale] ?? EN_TEXT
}
