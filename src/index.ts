import express, { Request, Response, NextFunction } from 'express';
import mongoose, { Schema, Document } from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import ExcelJS from 'exceljs';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!API_KEY) {
  console.error('FATAL: a variavel de ambiente API_KEY e obrigatoria.');
  process.exit(1);
}
if (API_KEY.length < 24) {
  console.error('FATAL: API_KEY muito curta. Use pelo menos 24 caracteres aleatorios.');
  process.exit(1);
}

// Render usa proxy. Sem isso, rate-limit e logs de IP nao funcionam direito.
app.set('trust proxy', 1);

// Cabecalhos seguros (HSTS, X-Content-Type-Options, etc)
app.use(helmet());

// CORS controlado por whitelist (deixa requisicoes sem Origin para PowerShell/curl passarem)
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.length === 0) return cb(null, false);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Origem nao permitida'));
  }
}));

// Limite pequeno - inventario e pequeno
app.use(express.json({ limit: '64kb' }));

// --- RATE LIMITING ---
const limiterEscrita = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisicoes' }
});
const limiterLeitura = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisicoes' }
});

// --- AUTH ---
function exigirApiKey(req: Request, res: Response, next: NextFunction) {
  const recebida = req.header('x-api-key');
  if (!recebida || recebida !== API_KEY) {
    return res.status(401).json({ erro: 'Nao autorizado' });
  }
  next();
}

// --- INTERFACES ---
interface IDisco {
  Letra: string;
  Tipo: string;
  Modelo: string;
  TotalGB: number;
  LivreGB: number;
}
interface ICpu {
  Nome: string;
  Nucleos: number;
  ClockGHz: number;
}
interface IGpu {
  Nome: string;
  MemoriaGB: number;
}
interface ISistema {
  Nome: string;     // ex: "Microsoft Windows 11 Pro"
  Versao: string;   // ex: "23H2"
  Build: number;    // ex: 22631
}
interface IComputador extends Document {
  Hostname: string;
  IpAddress?: string;
  MacAddress?: string;
  Laboratorio: string;
  Sistema?: ISistema;
  Cpu?: ICpu;
  Gpus: IGpu[];
  Discos: IDisco[];
  UltimaAtualizacao: Date;
}

// --- VALIDACAO ---
function isHostnameValido(v: any): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v);
}
function sanitizarString(v: any, max: number): string {
  if (typeof v !== 'string') return '';
  // [\x00-\x1F] sao caracteres de controle, \x7F e DEL
  const semControle = v.replace(new RegExp('[\\x00-\\x1F\\x7F]', 'g'), '');
  return semControle.slice(0, max);
}
function numero(v: any, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// --- SCHEMAS ---
const DiscoSchema = new Schema<IDisco>({
  Letra: { type: String, maxlength: 5 },
  Tipo: { type: String, maxlength: 50 },
  Modelo: { type: String, maxlength: 200 },
  TotalGB: { type: Number, min: 0, max: 1_000_000 },
  LivreGB: { type: Number, min: 0, max: 1_000_000 }
}, { _id: false });

const CpuSchema = new Schema<ICpu>({
  Nome: { type: String, maxlength: 200 },
  Nucleos: { type: Number, min: 0, max: 256 },
  ClockGHz: { type: Number, min: 0, max: 20 }
}, { _id: false });

const GpuSchema = new Schema<IGpu>({
  Nome: { type: String, maxlength: 200 },
  MemoriaGB: { type: Number, min: 0, max: 1024 }
}, { _id: false });

const SistemaSchema = new Schema<ISistema>({
  Nome: { type: String, maxlength: 200 },
  Versao: { type: String, maxlength: 30 },
  Build: { type: Number, min: 0, max: 9_999_999 }
}, { _id: false });

const ComputadorSchema = new Schema<IComputador>({
  Hostname: {
    type: String,
    required: true,
    unique: true,
    maxlength: 64,
    match: /^[A-Za-z0-9._-]+$/
  },
  IpAddress: { type: String, maxlength: 45 },
  MacAddress: { type: String, maxlength: 32 },
  Laboratorio: { type: String, required: true, maxlength: 100 },
  Sistema: { type: SistemaSchema },
  Cpu: { type: CpuSchema },
  Gpus: { type: [GpuSchema], default: [] },
  Discos: { type: [DiscoSchema], default: [] },
  UltimaAtualizacao: { type: Date, default: Date.now }
});

const Computador = mongoose.model<IComputador>('Computador', ComputadorSchema);

// --- DB ---
const connectDB = async () => {
  if (mongoose.connection.readyState >= 1) return;
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI nao definida');
  }
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    console.log('MongoDB conectado');
  } catch (error: any) {
    console.error('Erro de conexao com o banco:', error?.message || 'desconhecido');
    throw error;
  }
};

// Middleware: garante conexao com o banco antes da rota, e diferencia
// "banco fora do ar" (503) de erro de aplicacao (500) nos logs/resposta.
async function requireDB(_req: Request, res: Response, next: NextFunction) {
  try {
    await connectDB();
    next();
  } catch (error: any) {
    console.error('DB indisponivel:', error?.message || 'desconhecido');
    return res.status(503).json({ erro: 'Banco de dados indisponivel' });
  }
}

// --- ROTAS ---
app.get('/', (_req, res) => {
  res.send('API Online');
});

// Healthcheck (sem auth, util pro Render)
app.get('/health', (_req, res) => {
  res.json({ ok: mongoose.connection.readyState === 1 });
});

// POST inventario - estacoes mandam dados aqui
app.post('/api/inventario', limiterEscrita, exigirApiKey, requireDB, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};

    if (!isHostnameValido(body.Hostname)) {
      return res.status(400).json({ erro: 'Hostname invalido' });
    }
    if (typeof body.Laboratorio !== 'string' || body.Laboratorio.length === 0) {
      return res.status(400).json({ erro: 'Laboratorio obrigatorio' });
    }

    const discos: IDisco[] = Array.isArray(body.Discos)
      ? body.Discos.slice(0, 20).map((d: any) => ({
          Letra: sanitizarString(d?.Letra, 5),
          Tipo: sanitizarString(d?.Tipo, 50),
          Modelo: sanitizarString(d?.Modelo, 200),
          TotalGB: numero(d?.TotalGB, 0, 1_000_000),
          LivreGB: numero(d?.LivreGB, 0, 1_000_000)
        }))
      : [];

    const gpus: IGpu[] = Array.isArray(body.Gpus)
      ? body.Gpus.slice(0, 10).map((g: any) => ({
          Nome: sanitizarString(g?.Nome, 200),
          MemoriaGB: numero(g?.MemoriaGB, 0, 1024)
        }))
      : [];

    const cpu: ICpu | undefined = body.Cpu && typeof body.Cpu === 'object'
      ? {
          Nome: sanitizarString(body.Cpu.Nome, 200),
          Nucleos: numero(body.Cpu.Nucleos, 0, 256),
          ClockGHz: numero(body.Cpu.ClockGHz, 0, 20)
        }
      : undefined;

    const sistema: ISistema | undefined = body.Sistema && typeof body.Sistema === 'object'
      ? {
          Nome: sanitizarString(body.Sistema.Nome, 200),
          Versao: sanitizarString(body.Sistema.Versao, 30),
          Build: numero(body.Sistema.Build, 0, 9_999_999)
        }
      : undefined;

    const dadosAtualizados = {
      Hostname: body.Hostname,
      IpAddress: sanitizarString(body.IpAddress, 45),
      MacAddress: sanitizarString(body.MacAddress, 32),
      Laboratorio: sanitizarString(body.Laboratorio, 100),
      Sistema: sistema,
      Cpu: cpu,
      Gpus: gpus,
      Discos: discos,
      // Salva em UTC. Formatamos para America/Sao_Paulo na hora de exibir.
      UltimaAtualizacao: new Date()
    };

    const resultado = await Computador.findOneAndUpdate(
      { Hostname: body.Hostname },
      dadosAtualizados,
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    console.log(`[INV] ${body.Hostname} - ${dadosAtualizados.Laboratorio}`);
    return res.status(200).json({ sucesso: true, id: resultado._id });
  } catch (error: any) {
    console.error('Erro POST /api/inventario:', error?.message || 'desconhecido');
    return res.status(500).json({ erro: 'Erro no servidor' });
  }
});

// GET inventario - listar maquinas (com filtro opcional por lab)
app.get('/api/inventario', limiterLeitura, exigirApiKey, requireDB, async (req: Request, res: Response) => {
  try {
    const filter: any = {};
    if (typeof req.query.laboratorio === 'string') {
      filter.Laboratorio = sanitizarString(req.query.laboratorio, 100);
    }
    const docs = await Computador.find(filter).lean();
    return res.status(200).json(docs);
  } catch (error: any) {
    console.error('Erro GET /api/inventario:', error?.message || 'desconhecido');
    return res.status(500).json({ erro: 'Erro no servidor' });
  }
});

// Build >= 22000 == Windows 11. Build 10240..19045 = Windows 10.
function classificarSO(s: any): 'w10' | 'w11' | 'outro' {
  const b = Number(s?.Build) || 0;
  const nome = (s?.Nome || '').toString();
  if (b >= 22000) return 'w11';
  if (b >= 10240 && b < 22000) return 'w10';
  if (/windows 11/i.test(nome)) return 'w11';
  if (/windows 10/i.test(nome)) return 'w10';
  return 'outro';
}

// GET excel - baixa um xlsx ja formatado
app.get('/api/inventario/excel', limiterLeitura, exigirApiKey, requireDB, async (_req: Request, res: Response) => {
  try {
    const docs = await Computador.find({}).lean();

    const wb = new ExcelJS.Workbook();
    wb.creator = 'API Inventario';
    wb.created = new Date();

    // Agrupa por lab
    const labs = new Map<string, any[]>();
    for (const d of docs) {
      const nomeLab = d.Laboratorio || 'SEM-LAB';
      if (!labs.has(nomeLab)) labs.set(nomeLab, []);
      labs.get(nomeLab)!.push(d);
    }

    const HEADER_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF1F4E78' } };
    const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };

    // === Aba Resumo ===
    const resumo = wb.addWorksheet('Resumo');
    resumo.columns = [
      { header: 'Laboratorio', key: 'lab', width: 28 },
      { header: 'Qtd Maquinas', key: 'qtd', width: 14 },
      { header: 'Win 10', key: 'w10', width: 8 },
      { header: 'Win 11', key: 'w11', width: 8 },
      { header: 'Outro SO', key: 'wOutro', width: 10 },
      { header: 'Total GB', key: 'totalGB', width: 12 },
      { header: 'Livre GB', key: 'livreGB', width: 12 },
      { header: 'NVMe', key: 'nvme', width: 8 },
      { header: 'SSD SATA', key: 'ssd', width: 10 },
      { header: 'HDD', key: 'hdd', width: 8 },
      { header: 'C/ GPU dedicada', key: 'gpu', width: 18 }
    ];
    resumo.getRow(1).font = HEADER_FONT;
    resumo.getRow(1).fill = HEADER_FILL;

    let tMaq = 0, tGB = 0, tLivre = 0, tNvme = 0, tSsd = 0, tHdd = 0, tGpu = 0;
    let tW10 = 0, tW11 = 0, tOutro = 0;
    const labsOrdenados = Array.from(labs.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    for (const [labName, machines] of labsOrdenados) {
      let mGB = 0, mLivre = 0, mNvme = 0, mSsd = 0, mHdd = 0, mGpu = 0;
      let mW10 = 0, mW11 = 0, mOutro = 0;
      for (const m of machines) {
        for (const d of (m.Discos || [])) {
          mGB += d.TotalGB || 0;
          mLivre += d.LivreGB || 0;
          if (d.Tipo === 'SSD NVMe') mNvme++;
          else if (d.Tipo === 'SSD SATA') mSsd++;
          else if (d.Tipo === 'HDD') mHdd++;
        }
        const temGpuDedicada = (m.Gpus || []).some((g: any) =>
          g?.Nome && !/microsoft|basic display|integrated|^intel\(r\) (uhd|hd|iris)/i.test(g.Nome));
        if (temGpuDedicada) mGpu++;
        const cls = classificarSO(m.Sistema);
        if (cls === 'w10') mW10++;
        else if (cls === 'w11') mW11++;
        else mOutro++;
      }
      resumo.addRow({
        lab: labName, qtd: machines.length,
        w10: mW10, w11: mW11, wOutro: mOutro,
        totalGB: Math.round(mGB), livreGB: Math.round(mLivre),
        nvme: mNvme, ssd: mSsd, hdd: mHdd, gpu: mGpu
      });
      tMaq += machines.length; tGB += mGB; tLivre += mLivre;
      tNvme += mNvme; tSsd += mSsd; tHdd += mHdd; tGpu += mGpu;
      tW10 += mW10; tW11 += mW11; tOutro += mOutro;
    }
    const totalRow = resumo.addRow({
      lab: 'TOTAL', qtd: tMaq,
      w10: tW10, w11: tW11, wOutro: tOutro,
      totalGB: Math.round(tGB), livreGB: Math.round(tLivre),
      nvme: tNvme, ssd: tSsd, hdd: tHdd, gpu: tGpu
    });
    totalRow.font = { bold: true };
    totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
    resumo.autoFilter = { from: 'A1', to: 'K1' };
    resumo.views = [{ state: 'frozen', ySplit: 1 }];

    // === Uma aba por laboratorio ===
    for (const [labName, machines] of labsOrdenados) {
      const safeName = (labName || 'SEM-LAB')
        .replace(/[\\\/\?\*\[\]:]/g, '_')
        .substring(0, 31);
      const sheet = wb.addWorksheet(safeName);
      sheet.columns = [
        { header: 'Hostname', key: 'host', width: 18 },
        { header: 'IP', key: 'ip', width: 16 },
        { header: 'MAC', key: 'mac', width: 20 },
        { header: 'SO', key: 'so', width: 28 },
        { header: 'Versao SO', key: 'soVersao', width: 12 },
        { header: 'Build', key: 'build', width: 9 },
        { header: 'CPU', key: 'cpu', width: 42 },
        { header: 'Nucleos', key: 'nucleos', width: 9 },
        { header: 'Clock GHz', key: 'ghz', width: 11 },
        { header: 'GPU(s)', key: 'gpu', width: 38 },
        { header: 'Discos', key: 'discos', width: 55 },
        { header: 'Total GB', key: 'totalGB', width: 11 },
        { header: 'Livre GB', key: 'livreGB', width: 11 },
        { header: 'Ultima Atualizacao', key: 'data', width: 22 }
      ];
      sheet.getRow(1).font = HEADER_FONT;
      sheet.getRow(1).fill = HEADER_FILL;

      const ordenadas = machines.slice().sort((a: any, b: any) =>
        (a.Hostname || '').localeCompare(b.Hostname || ''));

      for (const m of ordenadas) {
        const totalGBm = (m.Discos || []).reduce((s: number, d: any) => s + (d.TotalGB || 0), 0);
        const livreGBm = (m.Discos || []).reduce((s: number, d: any) => s + (d.LivreGB || 0), 0);
        sheet.addRow({
          host: m.Hostname,
          ip: m.IpAddress || '',
          mac: m.MacAddress || '',
          so: m.Sistema?.Nome || '',
          soVersao: m.Sistema?.Versao || '',
          build: m.Sistema?.Build ?? '',
          cpu: m.Cpu?.Nome || '',
          nucleos: m.Cpu?.Nucleos ?? '',
          ghz: m.Cpu?.ClockGHz ?? '',
          gpu: (m.Gpus || []).map((g: any) => g.Nome).filter(Boolean).join(' / '),
          discos: (m.Discos || []).map((d: any) => `${d.Letra}: ${d.Modelo} (${d.Tipo})`).join(' | '),
          totalGB: Math.round(totalGBm),
          livreGB: Math.round(livreGBm),
          data: m.UltimaAtualizacao
            ? new Date(m.UltimaAtualizacao).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
            : ''
        });
      }
      sheet.autoFilter = { from: 'A1', to: 'N1' };
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
    }

    const buffer = await wb.xlsx.writeBuffer();
    const filename = `inventario-${new Date().toISOString().substring(0, 10)}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(Buffer.from(buffer));
  } catch (error: any) {
    console.error('Erro Excel:', error?.message || 'desconhecido');
    return res.status(500).json({ erro: 'Erro ao gerar Excel' });
  }
});

// 404 padrao
app.use((_req, res) => res.status(404).json({ erro: 'Rota nao encontrada' }));

// Inicializacao
// Sobe o servidor mesmo se o banco estiver fora do ar no boot; requireDB
// tenta reconectar a cada requisicao e devolve 503 enquanto isso.
if (require.main === module) {
  connectDB().catch((error: any) => {
    console.error('Nao foi possivel conectar ao banco no boot:', error?.message || 'desconhecido');
  }).finally(() => {
    app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));
  });
}

export default app;
