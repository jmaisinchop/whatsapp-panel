// admin.service.ts
import { Injectable, Inject, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { WhatsappService } from '../whatsapp/whatsapp.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly whatsappService: WhatsappService,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
  ) {}

  async getBotProfile() {
    const cacheKey = 'bot:profile';
    const cached = await this.cacheManager.get(cacheKey);
    if (cached) {
      this.logger.debug('[CACHE] Perfil del bot servido desde caché');
      return cached;
    }

    this.logger.debug('[PROFILE] Obteniendo perfil del bot desde WhatsApp...');
    const profile = await this.whatsappService.getBotProfile();

    await this.cacheManager.set(cacheKey, profile, 3600);
    this.logger.debug('[CACHE] Perfil del bot guardado en caché (1 hora)');

    return profile;
  }

  async updateProfilePicture(file: Express.Multer.File) {
    if (!file) {
      throw new Error('No se proporcionó ningún archivo.');
    }

    const imageSource = file.buffer || file.path;

    if (!imageSource) {
      throw new Error('El archivo no tiene contenido válido (buffer o path faltante).');
    }

    await this.whatsappService.setProfilePicture(imageSource);

    await this.cacheManager.del('bot:profile');
    this.logger.log('[CACHE] Caché de perfil del bot invalidado');

    return { message: 'Foto de perfil actualizada con éxito.' };
  }

  async updateBotStatus(newStatus: string) {
    await this.whatsappService.setBotStatus(newStatus);
    await this.cacheManager.del('bot:profile');
    this.logger.log('[CACHE] Caché de perfil del bot invalidado');
    return { message: 'Estado/Info del perfil actualizado con éxito.' };
  }

  async getWhatsAppHealth() {
    const health = this.whatsappService.getHealthStatus();
    let status: 'healthy' | 'degraded' | 'down';
    
    if (health.isReady && !health.circuitBreaker.isOpen) {
      status = 'healthy';
    } else if (health.isReady && health.circuitBreaker.isOpen) {
      status = 'degraded';
    } else {
      status = 'down';
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      details: {
        connected: health.isReady,
        reconnectAttempts: health.reconnectAttempts,
        maxReconnectAttempts: health.maxReconnectAttempts,
        circuitBreaker: {
          isOpen: health.circuitBreaker.isOpen,
          failures: health.circuitBreaker.failures,
        },
      },
      message: this.getHealthMessage(status, health),
    };
  }

  private getHealthMessage(
    status: 'healthy' | 'degraded' | 'down', 
    health: any
  ): string {
    if (status === 'healthy') {
      return 'WhatsApp funcionando correctamente';
    } else if (status === 'degraded') {
      return `WhatsApp conectado pero con ${health.circuitBreaker.failures} fallos recientes`;
    } else {
      return `WhatsApp desconectado (${health.reconnectAttempts}/${health.maxReconnectAttempts} intentos)`;
    }
  }
}