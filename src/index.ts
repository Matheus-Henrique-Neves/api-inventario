import express, { Request, Response } from 'express';
import mongoose, { Schema, Document } from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// --- 1. DEFINIÇÃO DO BANCO DE DADOS (MONGOOSE) ---

// Interface TypeScript para garantir tipagem
interface IDisco {
  Letra: string;
  Tipo: string;
  Modelo: string;
  TotalGB: number;
  LivreGB: number;
}

interface IComputador extends Document {
  Hostname: string;
  MacAddress: string;
  Laboratorio: string;
  Discos: IDisco[];
  UltimaAtualizacao: Date;
}

// Schema do MongoDB
const ComputadorSchema = new Schema({
  Hostname: { type: String, required: true, unique: true }, // Hostname é a chave única
  MacAddress: { type: String, required: true },
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

// Modelo
const Computador = mongoose.model<IComputador>('Computador', ComputadorSchema);

// --- 2. CONEXÃO COM O MONGODB ---
const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI não definida no .env");
    }
    await mongoose.connect(process.env.MONGO_URI);
    console.log('📦 MongoDB Conectado!');
  } catch (error) {
    console.error('Erro ao conectar no MongoDB:', error);
    process.exit(1);
  }
};

// --- 3. ROTAS ---

// Rota de teste
app.get('/', (req: Request, res: Response) => {
  res.send('API de Inventário de TI está online! 🚀');
});

// Rota principal que recebe o POST do PowerShell
app.post('/api/inventario', async (req: Request, res: Response) => {
  try {
    const { Hostname, MacAddress, Laboratorio, Discos } = req.body;

    // Validação básica
    if (!Hostname || !Discos) {
      return res.status(400).json({ erro: 'Hostname e Discos são obrigatórios.' });
    }

    // Lógica de UPSERT (Update or Insert)
    // Procura pelo Hostname. Se achar, atualiza. Se não achar, cria novo.
    const filtro = { Hostname: Hostname };
    const dadosAtualizados = {
      MacAddress,
      Laboratorio,
      Discos,
      UltimaAtualizacao: new Date()
    };

    const resultado = await Computador.findOneAndUpdate(filtro, dadosAtualizados, {
      new: true,   // Retorna o dado novo
      upsert: true // Cria se não existir
    });

    console.log(`✅ Dados recebidos e atualizados: ${Hostname}`);
    return res.status(200).json({ mensagem: 'Sucesso', dados: resultado });

  } catch (error) {
    console.error('Erro ao salvar:', error);
    return res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// Inicialização (Apenas se não for Vercel, o Vercel exporta o app)
if (require.main === module) {
    connectDB().then(() => {
        app.listen(PORT, () => {
        console.log(`🔥 Servidor rodando na porta ${PORT}`);
        });
    });
}

export default app;