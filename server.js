const http = require('http');
const fs = require('fs');
const path = require('path');

const port = process.env.PORT || 8787;
const projectDir = __dirname;
const dataDir = path.join(projectDir, 'data');
const metadataPath = path.join(dataDir, 'metadata.json');
const allowedBaseExtensions = new Set(['.xlsx', '.xls', '.csv']);
const monthKeys = new Set(Array.from({ length: 12 }, (_, index) => String(index + 1)));
const areaKeys = new Set(['area1', 'area2']);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

fs.mkdirSync(dataDir, { recursive: true });

function sendFile(response, filePath, contentType) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500, {
        'Content-Type': 'text/plain; charset=utf-8'
      });
      response.end(error.code === 'ENOENT' ? 'Arquivo nao encontrado.' : 'Erro ao ler arquivo.');
      return;
    }

    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store'
    });
    response.end(content);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(text);
}

function resolveProjectFile(urlPath) {
  const decodedPath = decodeURIComponent(urlPath.split('?')[0]);
  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const resolvedPath = path.resolve(projectDir, relativePath);

  if (!resolvedPath.startsWith(projectDir)) {
    return null;
  }

  return resolvedPath;
}

function normalizeMonth(value) {
  const month = String(value || '').trim();

  return monthKeys.has(month) ? month : '';
}

function normalizeArea(value) {
  const area = String(value || '').trim().toLowerCase();

  return areaKeys.has(area) ? area : 'area1';
}

function getMonthFromUrl(url) {
  try {
    const parsedUrl = new URL(url, 'http://localhost');

    return normalizeMonth(parsedUrl.searchParams.get('month'));
  } catch (error) {
    return '';
  }
}

function getAreaFromUrl(url) {
  try {
    const parsedUrl = new URL(url, 'http://localhost');

    return normalizeArea(parsedUrl.searchParams.get('area'));
  } catch (error) {
    return 'area1';
  }
}

function readMetadata(area) {
  if (!fs.existsSync(metadataPath)) {
    return { areas: { [area]: { months: {} } } };
  }

  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

    if (metadata.areas) {
      metadata.areas[area] = metadata.areas[area] || { months: {} };
      return metadata;
    }

    if (metadata.months) {
      return { areas: { area1: metadata, area2: { months: {} } } };
    }

    if (metadata.storedName) {
      const legacyMonth = metadata.updatedAt
        ? String(new Date(metadata.updatedAt).getMonth() + 1)
        : String(new Date().getMonth() + 1);

      return { areas: { area1: { months: { [legacyMonth]: metadata } }, area2: { months: {} } } };
    }

    return { areas: { [area]: { months: {} } } };
  } catch (error) {
    return { areas: { [area]: { months: {} } } };
  }
}

function getPublishedMetadata(area, month) {
  const metadata = readMetadata(area);
  const areaMetadata = metadata.areas[area] || { months: {} };
  const monthMetadata = areaMetadata.months[month] || {};
  const filePath = path.join(dataDir, monthMetadata.storedName || '');

  if (!monthMetadata.storedName || !fs.existsSync(filePath)) {
    return { exists: false, area, month };
  }

  return {
    exists: true,
    area,
    month,
    fileName: monthMetadata.fileName,
    storedName: monthMetadata.storedName,
    rowsName: monthMetadata.rowsName,
    updatedAt: monthMetadata.updatedAt,
    rowsUpdatedAt: monthMetadata.rowsUpdatedAt,
    size: monthMetadata.size,
    url: '/data/' + encodeURIComponent(monthMetadata.storedName),
    rowsUrl: monthMetadata.rowsName && fs.existsSync(path.join(dataDir, monthMetadata.rowsName))
      ? '/data/' + encodeURIComponent(monthMetadata.rowsName)
      : ''
  };
}

function getAllPublishedMetadata(area) {
  const months = {};

  monthKeys.forEach((month) => {
    const monthMetadata = getPublishedMetadata(area, month);

    if (monthMetadata.exists) {
      months[month] = monthMetadata;
    }
  });

  return {
    exists: Object.keys(months).length > 0,
    months
  };
}

function deletePreviousBases(area, month, keepNames) {
  const keep = new Set((keepNames || []).filter(Boolean));

  fs.readdirSync(dataDir).forEach((name) => {
    const pattern = new RegExp('^' + area + '-current-(base|rows)-' + month + '(?:-[0-9]+)?\\.(xlsx|xls|csv|json)$', 'i');

    if (!pattern.test(name) || keep.has(name)) {
      return;
    }

    try {
      fs.unlinkSync(path.join(dataDir, name));
    } catch (error) {
      console.warn('Nao foi possivel apagar base antiga, seguindo com novo arquivo:', name, error.message);
    }
  });
}

function createStoredName(area, type, month, extension) {
  const timestamp = Date.now();
  const suffix = Math.random().toString(36).slice(2, 8);

  return area + '-current-' + type + '-' + month + '-' + timestamp + '-' + suffix + extension;
}

function writeFileWithRetry(filePath, content, attempts = 6) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.writeFileSync(filePath, content, { flag: 'wx' });
      return;
    } catch (error) {
      lastError = error;

      if (!['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(error.code) || attempt === attempts) {
        break;
      }

      const waitUntil = Date.now() + attempt * 120;
      while (Date.now() < waitUntil) {}
    }
  }

  throw lastError;
}
function writeMonthMetadata(area, month, nextMetadata) {
  const metadata = readMetadata(area);

  metadata.areas[area] = metadata.areas[area] || { months: {} };
  metadata.areas[area].months[month] = nextMetadata;
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
}

function getLegacyPublishedMetadata() {
  if (!fs.existsSync(metadataPath)) {
    return { exists: false };
  }

  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const filePath = path.join(dataDir, metadata.storedName || '');

    if (!metadata.storedName || !fs.existsSync(filePath)) {
      return { exists: false };
    }

    return {
      exists: true,
      fileName: metadata.fileName,
      storedName: metadata.storedName,
      updatedAt: metadata.updatedAt,
      size: metadata.size,
      url: '/data/' + encodeURIComponent(metadata.storedName)
    };
  } catch (error) {
    return { exists: false };
  }
}

function collectRequestBody(request, callback) {
  const chunks = [];

  request.on('data', (chunk) => {
    chunks.push(chunk);
  });

  request.on('end', () => {
    callback(null, Buffer.concat(chunks));
  });

  request.on('error', (error) => {
    callback(error);
  });
}

function handleBaseUpload(request, response) {
  const configuredPassword = process.env.ADMIN_PASSWORD;
  const providedPassword = request.headers['x-admin-password'] || '';
  const month = normalizeMonth(request.headers['x-base-month']);
  const area = normalizeArea(request.headers['x-base-area']);

  if (!configuredPassword) {
    sendText(response, 500, 'ADMIN_PASSWORD nao configurada no servidor.');
    return;
  }

  if (providedPassword !== configuredPassword) {
    sendText(response, 401, 'Senha invalida.');
    return;
  }

  if (!month) {
    sendText(response, 400, 'Mes invalido para publicacao.');
    return;
  }

  const originalName = decodeURIComponent(request.headers['x-file-name'] || '');
  const extension = path.extname(originalName).toLowerCase();

  if (!allowedBaseExtensions.has(extension)) {
    sendText(response, 400, 'Formato nao aceito. Envie .xlsx, .xls ou .csv.');
    return;
  }

  collectRequestBody(request, (error, body) => {
    if (error || !body || body.length === 0) {
      sendText(response, 400, 'Arquivo vazio ou invalido.');
      return;
    }

    try {
      const storedName = createStoredName(area, 'base', month, extension);
      const storedPath = path.join(dataDir, storedName);
      const updatedAt = new Date().toISOString();
      const metadata = {
        fileName: path.basename(originalName),
        storedName,
        updatedAt,
        size: body.length
      };

      writeFileWithRetry(storedPath, body);
      writeMonthMetadata(area, month, metadata);
      deletePreviousBases(area, month, [storedName, metadata.rowsName]);

      sendJson(response, 200, getPublishedMetadata(area, month));
    } catch (writeError) {
      console.error('Erro ao publicar base:', writeError);
      sendText(response, 500, 'Erro ao salvar a base no servidor: ' + writeError.message);
    }
  });
}

function handleRowsUpload(request, response) {
  const configuredPassword = process.env.ADMIN_PASSWORD;
  const providedPassword = request.headers['x-admin-password'] || '';
  const month = normalizeMonth(request.headers['x-base-month']);
  const area = normalizeArea(request.headers['x-base-area']);

  if (!configuredPassword) {
    sendText(response, 500, 'ADMIN_PASSWORD nao configurada no servidor.');
    return;
  }

  if (providedPassword !== configuredPassword) {
    sendText(response, 401, 'Senha invalida.');
    return;
  }

  if (!month) {
    sendText(response, 400, 'Mes invalido para publicacao.');
    return;
  }

  collectRequestBody(request, (error, body) => {
    if (error || !body || body.length === 0) {
      sendText(response, 400, 'Dados processados vazios ou invalidos.');
      return;
    }

    try {
      const metadata = readMetadata(area);
      const areaMetadata = metadata.areas[area] || { months: {} };
      const monthMetadata = areaMetadata.months[month];

      if (!monthMetadata || !monthMetadata.storedName) {
        sendText(response, 400, 'Publique a base do mes antes de salvar os dados processados.');
        return;
      }

      const rowsName = createStoredName(area, 'rows', month, '.json');
      const rowsPath = path.join(dataDir, rowsName);

      writeFileWithRetry(rowsPath, body);
      monthMetadata.rowsName = rowsName;
      monthMetadata.rowsUpdatedAt = new Date().toISOString();
      metadata.areas[area] = metadata.areas[area] || { months: {} };
      metadata.areas[area].months[month] = monthMetadata;
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
      deletePreviousBases(area, month, [monthMetadata.storedName, rowsName]);

      sendJson(response, 200, getPublishedMetadata(area, month));
    } catch (writeError) {
      console.error('Erro ao salvar dados processados:', writeError);
      sendText(response, 500, 'Erro ao congelar os dados do mes: ' + writeError.message);
    }
  });
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url.startsWith('/api/latest-base')) {
    const month = getMonthFromUrl(request.url);
    const area = getAreaFromUrl(request.url);

    sendJson(response, 200, month ? getPublishedMetadata(area, month) : getAllPublishedMetadata(area));
    return;
  }

  if (request.method === 'POST' && request.url.startsWith('/api/upload-base')) {
    handleBaseUpload(request, response);
    return;
  }

  if (request.method === 'POST' && request.url.startsWith('/api/upload-rows')) {
    handleRowsUpload(request, response);
    return;
  }

  const filePath = resolveProjectFile(request.url);

  if (!filePath) {
    sendText(response, 403, 'Acesso negado.');
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  sendFile(response, filePath, mimeTypes[extension] || 'application/octet-stream');
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Dashboard rodando na porta ${port}`);
});

