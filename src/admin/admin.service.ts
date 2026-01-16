// src/admin/admin.service.ts - VERSIÓN CORREGIDA (SONARLINT S2933)

import { Injectable, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { WhatsappService } from '../whatsapp/whatsapp.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly whatsappService: WhatsappService,
    @Inject(CACHE_MANAGER)
    // ✅ CORRECCIÓN: Se agregó 'readonly' aquí
    private readonly cacheManager: Cache,
  ) {}

  async getBotProfile() {
    const cacheKey = 'bot:profile';
    const cached = await this.cacheManager.get(cacheKey);
    if (cached) {
      console.log('📦 Perfil del bot servido desde caché');
      return cached;
    }

    console.log('🔄 Obteniendo perfil del bot desde WhatsApp...');
    const profile = await this.whatsappService.getBotProfile();

    await this.cacheManager.set(cacheKey, profile, 3600);
    console.log('💾 Perfil del bot guardado en caché (1 hora)');

    return profile;
  }

  async updateProfilePicture(file: Express.Multer.File) {
    if (!file) {
      throw new Error('No se proporcionó ningún archivo.');
    }

    // Usamos file.buffer (memoria) si existe, sino file.path (disco)
    const imageSource = file.buffer || file.path;

    if (!imageSource) {
      throw new Error('El archivo no tiene contenido válido (buffer o path faltante).');
    }

    await this.whatsappService.setProfilePicture(imageSource);

    // Invalidar caché
    await this.cacheManager.del('bot:profile');
    console.log('🗑️ Caché de perfil del bot invalidado');

    return { message: 'Foto de perfil actualizada con éxito.' };
  }

  async updateBotStatus(newStatus: string) {
    await this.whatsappService.setBotStatus(newStatus);
    await this.cacheManager.del('bot:profile');
    console.log('🗑️ Caché de perfil del bot invalidado');
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