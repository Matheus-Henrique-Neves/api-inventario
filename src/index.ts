import express, { Request, Response } from 'express';
import mongoose, { Schema, Document } from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- INTERFACES ---
interface IDisco {
  Letra: string;
  Tipo: string;
  Modelo: string;
  TotalGB: number;
  LivreGB: number;
}

interface IComputador extends Document {
  Hostname: string;
  IpAddress: string;     // <--- NOVO: Tipo na Interface
  MacAddress: string;
  Laboratorio: string;
  Discos: IDisco[];
  UltimaAtualizacao: Date;
}

// --- SCHEMA ---
const ComputadorSchema = new Schema({
  Hostname: { type: String, required: true, unique: true },
  IpAddress: { type: String },    // <--- NOVO: Campo no Banco
  MacAddress: { type: String },
  Laboratorio: { type: String, required: true },
  Discos: [
    {
      Letra: String,
      Tipo: String,
      Modelo: String,
      TotalGB: Number,
      LivreGB: Number
    }
  ],
  UltimaAtualizacao: { type: Date, default: Date.now }
});

const Computador = mongoose.model<IComputador>('Computador', ComputadorSchema);

// --- CONEXÃO ---
const connectDB = async () => {
  if (mongoose.connection.readyState >= 1) return;
  if (!process.env.MONGO_URI) return;
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("📦 MongoDB Conectado");
  } catch (error) {
    console.error("Erro Conexão:", error);
  }
};

// --- ROTA ---
app.get('/', (req, res) => { res.send('API Online'); });

app.post('/api/inventario', async (req: Request, res: Response) => {
  await connectDB();

  try {
    // 1. Recebe o IpAddress do corpo da requisição
    const { Hostname, IpAddress, MacAddress, Laboratorio, Discos } = req.body;

    if (!Hostname) return res.status(400).json({ erro: 'Hostname obrigatório.' });

    // Ajuste Timezone Brasil (-3h)
    const dataBrasil = new Date();
    dataBrasil.setHours(dataBrasil.getHours() - 3);

    const dadosAtualizados = {
      Hostname,
      IpAddress,     // <--- NOVO: Salva no objeto
      MacAddress,
      Laboratorio,
      Discos,
      UltimaAtualizacao: dataBrasil
    };

    const resultado = await Computador.findOneAndUpdate(
      { Hostname: Hostname },
      dadosAtualizados,
      { new: true, upsert: true }
    );

    console.log(`📥 Recebido: ${Hostname} [${IpAddress}] - ${Laboratorio}`);
    
    return res.status(200).json({ sucesso: true, id: resultado._id });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ erro: 'Erro no servidor' });
  }
});

// Inicialização
if (require.main === module) {
  connectDB().then(() => {
    app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));
  });
}

export default app;