/* EXACT LAB — envio de arquivos grandes para a pasta do caso no Google Drive.
 * Usado pelo quadro (equipe), pelo formulário de pedido e pela página de acompanhamento (dentista).
 *
 *  - Separa sozinho: STL/PLY/OBJ → pasta STL · fotos e vídeos → Fotos · tomografia → DICOM · resto → pasta principal
 *  - Pasta de tomografia (ou arquivos .dcm soltos) vira um único "DICOM - <paciente> - <pasta>.zip", montado durante o envio
 *  - Manda em partes de 8 MB, direto para o Google Drive; se o navegador não conseguir, passa pelo Apps Script
 *  - Se a internet oscilar, tenta de novo de onde parou
 *
 * Uso:  EXU.coletar(dataTransfer ou FileList) → itens ;  EXU.enviar(itens, {api, id, token, paciente, origemEnvio, aoConcluir})
 */
(function () {
  const PARTE = 8 * 1024 * 1024;           // múltiplo de 256 KB (exigência do Google)
  const LEITURA = 4 * 1024 * 1024;
  const FFLATE = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js';
  let modo = 'direto';                      // vira 'repasse' se o navegador não puder falar direto com o Google

  const ext = n => (String(n).toLowerCase().match(/\.([a-z0-9]+)$/) || [, ''])[1];
  const ehDicomArq = (n) => { const e = ext(n), b = String(n).split('/').pop().toUpperCase(); return e === 'dcm' || e === 'dicom' || b === 'DICOMDIR' || (!e && /^[A-Z0-9_]{1,16}$/i.test(b)); };
  function destinoDe(nome) {
    const e = ext(nome);
    if (['stl', 'ply', 'obj', '3mf', 'dxd', 'off'].includes(e)) return 'STL';
    if (['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'mp4', 'mov', 'm4v', 'avi', '3gp'].includes(e)) return 'FOTOS';
    if (['dcm', 'dicom'].includes(e)) return 'DICOM';
    if (['zip', 'rar', '7z'].includes(e)) return /stl|scan|escane|modelo|model|intraoral/i.test(nome) ? 'STL' : 'DICOM';
    return '';
  }
  const NOME_DEST = { STL: 'STL', FOTOS: 'Fotos', DICOM: 'DICOM', '': 'Pasta principal' };
  const mb = b => (b / 1048576).toFixed(b < 10485760 ? 1 : 0).replace('.', ',') + ' MB';

  // ---------- coleta (arquivos soltos e pastas arrastadas) ----------
  function lerPasta(entry, base) {
    return new Promise(res => {
      const out = [], leitor = entry.createReader();
      const lote = () => leitor.readEntries(async ents => {
        if (!ents.length) return res(out);
        for (const en of ents) {
          if (en.isFile) out.push(await new Promise(r => en.file(f => r({ file: f, caminho: base + en.name }), () => r(null))));
          else if (en.isDirectory) out.push(...await lerPasta(en, base + en.name + '/'));
        }
        lote();
      }, () => res(out));
      lote();
    });
  }
  async function coletar(fonte) {
    const pastas = [], soltos = [];
    if (fonte && fonte.items && fonte.items.length && fonte.items[0].webkitGetAsEntry) {
      const ents = [...fonte.items].filter(i => i.kind === 'file').map(i => i.webkitGetAsEntry()).filter(Boolean);  // precisa ser síncrono
      for (const en of ents) {
        if (en.isDirectory) pastas.push({ nome: en.name, arquivos: (await lerPasta(en, en.name + '/')).filter(Boolean) });
        else soltos.push(await new Promise(r => en.file(r, () => r(null))));
      }
    } else {
      [...(fonte && fonte.files ? fonte.files : fonte || [])].forEach(f => {   // <input type=file> (inclusive webkitdirectory)
        const rel = f.webkitRelativePath;
        if (rel && rel.includes('/')) { const raiz = rel.split('/')[0]; let p = pastas.find(x => x.nome === raiz); if (!p) pastas.push(p = { nome: raiz, arquivos: [] }); p.arquivos.push({ file: f, caminho: rel }); }
        else soltos.push(f);
      });
    }
    const itens = [];
    for (const p of pastas) {
      const temDicom = p.arquivos.some(a => ehDicomArq(a.caminho));
      if (temDicom) itens.push({ tipo: 'zip', nome: p.nome, arquivos: p.arquivos, destino: 'DICOM', tamanho: p.arquivos.reduce((s, a) => s + a.file.size, 0) });
      else p.arquivos.forEach(a => itens.push({ tipo: 'arquivo', file: a.file, nome: a.file.name, destino: destinoDe(a.file.name), tamanho: a.file.size }));
    }
    const dcmSoltos = soltos.filter(f => f && ['dcm', 'dicom'].includes(ext(f.name)));
    if (dcmSoltos.length) itens.push({ tipo: 'zip', nome: 'tomografia', arquivos: dcmSoltos.map(f => ({ file: f, caminho: f.name })), destino: 'DICOM', tamanho: dcmSoltos.reduce((s, f) => s + f.size, 0) });
    soltos.filter(f => f && !dcmSoltos.includes(f)).forEach(f => itens.push({ tipo: 'arquivo', file: f, nome: f.name, destino: destinoDe(f.name), tamanho: f.size }));
    return itens;
  }

  // ---------- painel de progresso ----------
  let painel, lista, titulo, ativos = 0;
  function montarPainel() {
    if (painel) return;
    const css = document.createElement('style');
    css.textContent = `#exu{position:fixed;right:16px;bottom:16px;width:min(380px,calc(100vw - 32px));background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,32,91,.28);z-index:9999;font:13px/1.4 Montserrat,system-ui,sans-serif;color:#0f2a3d;overflow:hidden}
#exu header{background:#00205b;color:#fff;padding:10px 14px;display:flex;align-items:center;gap:8px;font-weight:700}
#exu header button{margin-left:auto;background:none;border:0;color:#fff;font-size:18px;cursor:pointer;line-height:1}
#exu ul{list-style:none;margin:0;padding:6px 14px 10px;max-height:300px;overflow:auto}
#exu li{padding:8px 0;border-bottom:1px solid #eef1f5}#exu li:last-child{border:0}
#exu .n{display:flex;gap:8px;justify-content:space-between}#exu .n b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#exu .d{color:#6b7d8c;font-size:12px}#exu .s{white-space:nowrap;color:#6b7d8c;font-size:12px}
#exu .bar{height:5px;background:#eef1f5;border-radius:3px;margin-top:5px;overflow:hidden}#exu .bar i{display:block;height:100%;width:0;background:#de2777;transition:width .3s}
#exu li.ok .bar i{background:#1a8a5a}#exu li.err .s{color:#c0392b}#exu.min ul{display:none}`;
    document.head.appendChild(css);
    painel = document.createElement('div'); painel.id = 'exu';
    painel.innerHTML = '<header><span id="exu-t">Enviando arquivos</span><button id="exu-min" title="Minimizar">–</button><button id="exu-x" title="Fechar" hidden>×</button></header><ul></ul>';
    document.body.appendChild(painel);
    lista = painel.querySelector('ul'); titulo = painel.querySelector('#exu-t');
    painel.querySelector('#exu-min').onclick = () => painel.classList.toggle('min');
    painel.querySelector('#exu-x').onclick = () => { painel.remove(); painel = null; };
    window.addEventListener('beforeunload', e => { if (ativos > 0) { e.preventDefault(); e.returnValue = 'Ainda há arquivos sendo enviados.'; } });
  }
  function linha(item, nomeFinal) {
    montarPainel();
    const li = document.createElement('li');
    li.innerHTML = `<div class="n"><b></b><span class="s">na fila</span></div><div class="d"></div><div class="bar"><i></i></div>`;
    li.querySelector('b').textContent = nomeFinal; li.querySelector('b').title = nomeFinal;
    li.querySelector('.d').textContent = '→ ' + NOME_DEST[item.destino || ''] + ' · ' + mb(item.tamanho) + (item.tipo === 'zip' ? ` · ${item.arquivos.length} arquivos` : '');
    lista.appendChild(li);
    return {
      prog: (feito, total) => { const p = total ? Math.min(99, Math.floor(feito / total * 100)) : 0; li.querySelector('i').style.width = p + '%'; li.querySelector('.s').textContent = p + '% · ' + mb(feito); },
      msg: t => { li.querySelector('.s').textContent = t; },
      ok: () => { li.className = 'ok'; li.querySelector('i').style.width = '100%'; li.querySelector('.s').textContent = 'enviado ✓'; },
      erro: t => { li.className = 'err'; li.querySelector('.s').textContent = 'falhou'; li.querySelector('.d').textContent = t; }
    };
  }
  // mantém a tela do celular acesa durante o envio (se o navegador permitir)
  let trava = null;
  async function manterTela(on) {
    try {
      if (on && !trava && navigator.wakeLock) { trava = await navigator.wakeLock.request('screen'); trava.addEventListener('release', () => { trava = null; }); }
      if (!on && trava) { await trava.release(); trava = null; }
    } catch (e) { trava = null; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ativos > 0) manterTela(true); });
  function atualizarTitulo() {
    manterTela(ativos > 0);
    if (!painel) return;
    titulo.textContent = ativos > 0 ? `Enviando (${ativos} na fila) — deixe esta tela aberta` : 'Envio concluído ✓';
    painel.querySelector('#exu-x').hidden = ativos > 0;
  }

  // ---------- envio em partes ----------
  const b64 = u8 => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1] || ''); fr.readAsDataURL(new Blob([u8])); });
  const espera = ms => new Promise(r => setTimeout(r, ms));

  async function mandarParte(ctx, ses, bytes, inicio, ultimo, totalConhecido) {
    const total = ultimo ? String(inicio + bytes.length) : (totalConhecido ? String(totalConhecido) : '*');
    let consultar = false;
    for (let tent = 1; tent <= 7; tent++) {
      try {
        if (modo === 'direto' && !consultar) {
          let r;
          try { r = await fetch(ses, { method: 'PUT', headers: { 'Content-Range': `bytes ${inicio}-${inicio + bytes.length - 1}/${total}` }, body: bytes }); }
          catch (e) { modo = 'repasse'; consultar = true; continue; }   // CORS bloqueado ou rede caiu → passa pelo Apps Script
          if (r.status === 200 || r.status === 201) return { fim: true };
          if (r.status === 308) return { fim: false };
          throw new Error('HTTP ' + r.status);
        }
        if (consultar) {                                  // pergunta ao Google quanto já chegou antes de reenviar
          const st = await ctx.api('upParte', { sessao: ses, total: ultimo ? total : (totalConhecido ? String(totalConhecido) : '*') });
          if (st.fim) return { fim: true };
          const pular = st.recebido - inicio;
          if (pular >= bytes.length && !ultimo) return { fim: false };
          if (pular > 0 && pular < bytes.length) { bytes = bytes.subarray(pular); inicio = st.recebido; }
          consultar = false;
        }
        const j = await ctx.api('upParte', { sessao: ses, inicio, total, base64: await b64(bytes) });
        if (j.fim) return { fim: true };
        if (j.recebido < inicio + bytes.length) { consultar = true; throw new Error('parte incompleta'); }
        return { fim: false };
      } catch (e) {
        if (tent === 7) throw e;
        consultar = true;
        await espera(1500 * tent);
      }
    }
  }

  async function iniciar(ctx, nome, mime, tamanho, destino) {
    const j = await ctx.api('upIniciar', { id: ctx.id, token: ctx.token, origemEnvio: ctx.origemEnvio, arquivo: nome, mime, tamanho, destino, origem: location.origin });
    return j.sessao;
  }

  async function enviarArquivo(ctx, item, ui) {
    const f = item.file, ses = await iniciar(ctx, f.name, f.type || 'application/octet-stream', f.size, item.destino);
    if (!f.size) { await mandarParte(ctx, ses, new Uint8Array(0), 0, true, 0); return; }
    for (let pos = 0; pos < f.size; pos += PARTE) {
      const pedaco = new Uint8Array(await f.slice(pos, pos + PARTE).arrayBuffer());
      await mandarParte(ctx, ses, pedaco, pos, pos + pedaco.length >= f.size, f.size);
      ui.prog(pos + pedaco.length, f.size);
    }
  }

  function carregarFflate() {
    if (window.fflate) return Promise.resolve();
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = FFLATE; s.onload = res; s.onerror = () => rej(new Error('Não foi possível carregar o compactador')); document.head.appendChild(s); });
  }

  async function enviarZip(ctx, item, ui, nomeZip) {
    await carregarFflate();
    const ses = await iniciar(ctx, nomeZip, 'application/zip', 0, 'DICOM');
    let fila = [], naFila = 0, enviado = 0, lido = 0, erroZip = null;
    const zip = new fflate.Zip((err, dado) => { if (err) erroZip = err; else if (dado && dado.length) { fila.push(dado); naFila += dado.length; } });
    const juntar = n => { const out = new Uint8Array(n); let o = 0; while (o < n) { const c = fila[0], k = Math.min(c.length, n - o); out.set(c.subarray(0, k), o); o += k; if (k === c.length) fila.shift(); else fila[0] = c.subarray(k); } naFila -= n; return out; };
    const escoar = async (fim) => {
      while (naFila > PARTE || (fim && naFila > 0)) {
        const n = naFila > PARTE ? PARTE : naFila, ultimo = fim && n === naFila;
        await mandarParte(ctx, ses, juntar(n), enviado, ultimo, 0);
        enviado += n;
      }
    };
    for (const a of item.arquivos) {
      const ent = new fflate.ZipPassThrough(a.caminho);
      ent.mtime = a.file.lastModified || Date.now();
      zip.add(ent);
      if (!a.file.size) ent.push(new Uint8Array(0), true);
      for (let pos = 0; pos < a.file.size; pos += LEITURA) {
        const u8 = new Uint8Array(await a.file.slice(pos, pos + LEITURA).arrayBuffer());
        ent.push(u8, pos + u8.length >= a.file.size);
        lido += u8.length;
        if (erroZip) throw erroZip;
        await escoar(false);
        ui.prog(lido, item.tamanho);
      }
    }
    zip.end();
    if (erroZip) throw erroZip;
    await escoar(true);
    return enviado;
  }

  let corrente = Promise.resolve();
  function enviar(itens, ctx) {
    const limpo = s => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').trim();
    const tarefas = itens.map(item => {
      const nome = item.tipo === 'zip' ? `DICOM - ${limpo(ctx.paciente) || 'paciente'}${item.nome && item.nome !== 'tomografia' ? ' - ' + limpo(item.nome) : ''}.zip` : item.nome;
      const ui = linha(item, nome); ativos++; atualizarTitulo();
      corrente = corrente.then(async () => {
        try {
          ui.msg('enviando…');
          let tamanhoFinal = item.tamanho;
          if (item.tipo === 'zip') tamanhoFinal = await enviarZip(ctx, item, ui, nome);
          else await enviarArquivo(ctx, item, ui);
          await ctx.api('upConcluir', { id: ctx.id, token: ctx.token, origemEnvio: ctx.origemEnvio, arquivo: nome, destino: item.destino, tamanho: tamanhoFinal });
          ui.ok();
          if (ctx.aoConcluir) try { ctx.aoConcluir(item, nome); } catch (e) {}
          return { nome, ok: true };
        } catch (e) {
          ui.erro((e && e.message) || 'erro de conexão');
          return { nome, ok: false, erro: (e && e.message) || 'erro' };
        } finally { ativos--; atualizarTitulo(); }
      });
      return corrente;
    });
    return Promise.all(tarefas);
  }

  window.EXU = { coletar, enviar, destinoDe, NOME_DEST, mb, emAndamento: () => ativos > 0 };
})();
