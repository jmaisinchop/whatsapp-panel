// src/conversation-flow/redis-state-store.ts - VERSIÓN CORREGIDA
// =====================================================
// ✅ AGREGADO: Métodos de distributed lock para evitar race conditions
// =====================================================

import { Injectable, Logger } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import { ConversationStep } from './conversation-state.enum';
import { UserState } from './conversation-flow.interface';

@Injectable()
export class RedisStateStore {
  private logger = new Logger(RedisStateStore.name);
  private redisClient: RedisClientType;
  private readonly WAITING_CHATS_QUEUE_KEY = 'waiting_chats_queue';

  constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    this.redisClient = createClient({
      url: redisUrl,
    });

    this.redisClient.on('error', (err) => {
      this.logger.error('Redis Client Error', err);
    });

    this.redisClient.on('connect', () => {
      this.logger.log(`🔌 Conectado exitosamente a Redis en ${redisUrl}`);
    });

    this.redisClient.connect().catch(err => {
        this.logger.error('No se pudo conectar a Redis al iniciar:', err);
    });
  }

  private getKey(contactNumber: string): string {
    return `conversation_state:${contactNumber}`;
  }

  // ======================================================
  // LÓGICA DE ESTADO (User State)
  // ======================================================

  private getDefaultState(): UserState {
    return {
      step: ConversationStep.START,
      termsAccepted: false,
      isFallback: false 
    };
  }

  public async getUserState(contactNumber: string): Promise<UserState> {
    const key = this.getKey(contactNumber);
    
    try {
        const raw = await this.redisClient.get(key);
        const defaultState = this.getDefaultState();

        if (!raw) {
          await this.setUserState(contactNumber, defaultState);
          return defaultState;
        }

        const parsedState = JSON.parse(raw);

        return {
          ...defaultState,
          ...parsedState
        };
    } catch (error) {
        this.logger.error(`Error obteniendo estado de Redis para ${contactNumber}`, error);
        return this.getDefaultState();
    }
  }

  public async setUserState(contactNumber: string, state: UserState) {
    const key = this.getKey(contactNumber);
    const str = JSON.stringify(state);
    await this.redisClient.set(key, str, { EX: 86400 }); // 24 horas
  }

  public async resetUserState(contactNumber: string) {
    this.logger.log(`Reseteando estado para ${contactNumber}`);
    await this.setUserState(contactNumber, this.getDefaultState());
  }

  // ======================================================
  // COLA DE ESPERA (Waiting Queue)
  // ======================================================

  public async addChatToWaitingQueue(chatId: number): Promise<void> {
    await this.redisClient.lPush(this.WAITING_CHATS_QUEUE_KEY, String(chatId));
    this.logger.log(`Chat #${chatId} añadido a la cola de espera.`);
  }

  public async getNextChatInQueue(): Promise<number | null> {
    const chatIdString = await this.redisClient.rPop(this.WAITING_CHATS_QUEUE_KEY);
    if (chatIdString) {
      this.logger.log(`Chat #${chatIdString} obtenido de la cola para ser asignado.`);
      return parseInt(chatIdString, 10);
    }
    return null;
  }

  // ======================================================
  // ✅ NUEVOS MÉTODOS: DISTRIBUTED LOCK
  // ======================================================

  /**
   * Adquirir un lock distribuido usando Redis SET NX PX
   * Esto evita que múltiples instancias procesen el mismo chat simultáneamente
   * 
   * @param key Clave del lock (ej: 'chat:processing:593991234567')
   * @param ttlMs Tiempo de vida del lock en milisegundos (default: 30s)
   * @returns true si se adquirió el lock, false si ya existe
   */
  public async acquireLock(key: string, ttlMs: number = 30000): Promise<boolean> {
    try {
      const result = await this.redisClient.set(key, '1', {
        PX: ttlMs, // TTL en milisegundos
        NX: true,  // Solo establecer si no existe (SET if Not eXists)
      });
      
      if (result === 'OK') {
        this.logger.debug(`🔒 Lock adquirido: ${key} (${ttlMs}ms)`);
        return true;
      }
      
      this.logger.debug(`🔒 Lock ya existe: ${key}`);
      return false;
    } catch (error) {
      this.logger.error(`❌ Error adquiriendo lock ${key}:`, error);
      return false;
    }
  }

  /**
   * Liberar un lock distribuido
   * @param key Clave del lock
   */
  public async releaseLock(key: string): Promise<void> {
    try {
      await this.redisClient.del(key);
      this.logger.debug(`🔓 Lock liberado: ${key}`);
    } catch (error) {
      this.logger.error(`❌ Error liberando lock ${key}:`, error);
    }
  }

  /**
   * Verificar si un lock existe
   * @param key Clave del lock
   * @returns true si el lock existe
   */
  public async hasLock(key: string): Promise<boolean> {
    try {
      const exists = await this.redisClient.exists(key);
      return exists === 1;
    } catch (error) {
      this.logger.error(`❌ Error verificando lock ${key}:`, error);
      return false;
    }
  }
}