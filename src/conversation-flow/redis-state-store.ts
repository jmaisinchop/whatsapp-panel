// redis-state-store.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import { ConversationStep } from './conversation-state.enum';
import { UserState } from './conversation-flow.interface';

@Injectable()
export class RedisStateStore implements OnModuleInit {
  private readonly logger = new Logger(RedisStateStore.name);
  private readonly redisClient: RedisClientType;
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
      this.logger.log(`[REDIS] Conectado exitosamente a Redis en ${redisUrl}`);
    });
  }

  async onModuleInit() {
    try {
      await this.redisClient.connect();
    } catch (err) {
      this.logger.error('No se pudo conectar a Redis al iniciar:', err);
    }
  }

  private getKey(contactNumber: string): string {
    return `conversation_state:${contactNumber}`;
  }

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
    await this.redisClient.set(key, str, { EX: 86400 });
  }

  public async resetUserState(contactNumber: string) {
    this.logger.log(`Reseteando estado para ${contactNumber}`);
    await this.setUserState(contactNumber, this.getDefaultState());
  }

  public async addChatToWaitingQueue(chatId: number): Promise<void> {
    await this.redisClient.lPush(this.WAITING_CHATS_QUEUE_KEY, String(chatId));
    this.logger.log(`Chat #${chatId} añadido a la cola de espera.`);
  }

  public async getNextChatInQueue(): Promise<number | null> {
    const chatIdString = await this.redisClient.rPop(this.WAITING_CHATS_QUEUE_KEY);
    if (chatIdString) {
      this.logger.log(`Chat #${chatIdString} obtenido de la cola para ser asignado.`);
      return Number.parseInt(chatIdString, 10);
    }
    return null;
  }

  public async acquireLock(key: string, ttlMs: number = 30000): Promise<boolean> {
    try {
      const result = await this.redisClient.set(key, '1', {
        PX: ttlMs,
        NX: true,
      });
      
      if (result === 'OK') {
        this.logger.debug(`[LOCK] Lock adquirido: ${key} (${ttlMs}ms)`);
        return true;
      }
      
      this.logger.debug(`[LOCK] Lock ya existe: ${key}`);
      return false;
    } catch (error) {
      this.logger.error(`[LOCK] Error adquiriendo lock ${key}:`, error);
      return false;
    }
  }

  public async releaseLock(key: string): Promise<void> {
    try {
      await this.redisClient.del(key);
      this.logger.debug(`[LOCK] Lock liberado: ${key}`);
    } catch (error) {
      this.logger.error(`[LOCK] Error liberando lock ${key}:`, error);
    }
  }

  public async hasLock(key: string): Promise<boolean> {
    try {
      const exists = await this.redisClient.exists(key);
      return exists === 1;
    } catch (error) {
      this.logger.error(`[LOCK] Error verificando lock ${key}:`, error);
      return false;
    }
  }
}