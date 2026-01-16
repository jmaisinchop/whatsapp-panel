// src/whatsapp/whatsapp.service.ts - VERSIÓN FINAL CORREGIDA

import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy
} from '@nestjs/common';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  jidNormalizedUser
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as pino from 'pino';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as fs from 'node:fs/promises'; // ✅ Best practice
import { lookup } from 'mime-types';
import * as qrcode from 'qrcode-terminal';
import * as path from 'node:path'; // ✅ Best practice

export interface SimplifiedMessage {
  from: string;
  body: string;
  hasMedia: boolean;
  media?: {
    mimetype: string;
    data: Buffer;
  };
}

interface RetryConfig {
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier: number;
}

interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappService.name);
  private sock: any;
  public isReady = false;

  private currentQR: string | null = null;
  private readonly MAX_FILE_SIZE = 50 * 1024 * 1024;

  private circuitBreaker: CircuitBreakerState = {
    failures: 0,
    lastFailure: 0,
    isOpen: false,
  };
  private readonly CIRCUIT_BREAKER_THRESHOLD = 5;
  private readonly CIRCUIT_BREAKER_TIMEOUT = 60000;

  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private reconnectTimer: NodeJS.Timeout | null = null;

  // ✅ 'readonly' agregado (SonarLint S2933)
  constructor(private readonly eventEmitter: EventEmitter2) { }

  async onModuleInit() {
    this.connectToWhatsApp();
  }

  async onModuleDestroy() {
    this.logger.log('🛑 Cerrando conexión con WhatsApp limpiamente...');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      if (this.sock) {
        await this.sock.sendPresenceUpdate('unavailable').catch((err) => this.logger.warn(err));
        await this.sock.ws.close();
        this.sock.end(undefined);
        this.sock = null;
        this.isReady = false;
      }
    } catch (error) {
      this.logger.error('❌ Error al cerrar WhatsApp:', error);
    }
  }

  public getConnectionState() {
    return {
      status: this.isReady ? 'connected' : 'disconnected',
      qr: this.currentQR,
    };
  }

  public async logout() {
    if (this.sock) {
      this.logger.log('🚪 Logout manual solicitado');
      await this.sock.logout();
      await this.handleLogout();
    }
  }

  private async connectToWhatsApp() {
    // === FIX START: LIMPIEZA DE ZOMBIES ===
    // Esto es lo que faltaba para evitar el error 440
    if (this.sock) {
      try {
        this.logger.debug('🧹 Limpiando conexión socket anterior para evitar conflictos...');
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        this.sock.end(undefined);
        this.sock = null;
      } catch (error) {
        this.logger.warn('⚠️ Error al limpiar socket anterior:', error);
      }
    }
    // === FIX END ===

    try {
      const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
      const { version } = await fetchLatestBaileysVersion();
      this.logger.log(`⚡️ Usando Baileys v${version.join('.')}`);

      this.sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['KIKA-Panel', 'Chrome', '1.0.0'],

        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 5000,

        markOnlineOnConnect: true,
      });

      this.setupEventHandlers(saveCreds);

    } catch (error) {
      this.logger.error('❌ Error fatal iniciando WhatsApp:', error);
      this.scheduleReconnect();
    }
  }

  private setupEventHandlers(saveCreds: () => Promise<void>) {
    this.setupConnectionHandler();
    this.setupCredentialsHandler(saveCreds);
    this.setupMessagesHandler();
  }

  private setupConnectionHandler() {
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.logger.log('📱 QR Code generado.');
        this.currentQR = qr;
        qrcode.generate(qr, { small: true });
        this.eventEmitter.emit('whatsapp.qr', qr);
      }

      if (connection === 'close') {
        this.isReady = false;
        this.currentQR = null;
        this.handleDisconnection(lastDisconnect);
        this.eventEmitter.emit('whatsapp.status', { status: 'disconnected' });
      } else if (connection === 'open') {
        this.handleSuccessfulConnection();
        this.currentQR = null;
        this.eventEmitter.emit('whatsapp.status', { status: 'connected' });
      }
    });
  }

  private async handleDisconnection(lastDisconnect: any) {
    const statusCode = (lastDisconnect.error as Boom)?.output?.statusCode;
    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

    if (statusCode === 440) {
      this.logger.warn('⚠️ Conflicto de sesión (440) detectado. Reintentando limpieza...');
      // Reduje el tiempo a 2s porque ahora tenemos limpieza automática en connectToWhatsApp
      this.scheduleReconnect(2000); 
      return;
    }

    if (statusCode === DisconnectReason.loggedOut) {
      await this.handleLogout();
    } else if (shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  private async handleLogout() {
    this.logger.warn('🚫 Sesión cerrada. Eliminando credenciales...');
    try {
      this.isReady = false;
      this.currentQR = null;
      await fs.rm('baileys_auth_info', { recursive: true, force: true });
      this.reconnectAttempts = 0;
      this.scheduleReconnect(5000);
      this.eventEmitter.emit('whatsapp.status', { status: 'disconnected' });
    } catch (error) {
      this.logger.error('❌ Error eliminando credenciales:', error);
    }
  }

  private scheduleReconnect(delayMs?: number) {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      this.logger.error(`❌ Máximo de intentos de reconexión alcanzado.`);
      return;
    }

    // === FIX START: Evitar timers duplicados ===
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    // === FIX END ===

    this.reconnectAttempts++;
    const delay = delayMs || Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
    
    this.reconnectTimer = setTimeout(() => {
      this.connectToWhatsApp();
    }, delay);
  }

  private handleSuccessfulConnection() {
    this.logger.log('✅ ¡Conexión con WhatsApp establecida!');
    this.isReady = true;
    this.reconnectAttempts = 0;
    this.resetCircuitBreaker();
    this.eventEmitter.emit('whatsapp.status', { status: 'connected' });
    this.eventEmitter.emit('whatsapp.ready');
  }

  private setupCredentialsHandler(saveCreds: () => Promise<void>) {
    this.sock.ev.on('creds.update', saveCreds);
  }

  private setupMessagesHandler() {
    this.sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe || !msg.key.remoteJid.endsWith('@s.whatsapp.net')) return;

      try {
        const simplifiedMessage = await this.processIncomingMessage(msg);
        this.eventEmitter.emit('whatsapp.message', simplifiedMessage);
      } catch (error) {
        this.logger.error('❌ Error procesando mensaje:', error);
      }
    });
  }

  private async processIncomingMessage(msg: any): Promise<SimplifiedMessage> {
    const from = msg.key.remoteJid;
    const messageContent = msg.message;
    const messageType = Object.keys(messageContent)[0];

    const body = messageContent.conversation
      || messageContent.extendedTextMessage?.text
      || messageContent.imageMessage?.caption
      || '';

    const hasMediaType = ['imageMessage', 'videoMessage', 'documentMessage'].includes(messageType);
    let hasMedia = hasMediaType;
    const simplifiedMessage: SimplifiedMessage = { from, body, hasMedia };

    if (hasMedia) {
      // Lógica simplificada: indicamos que tiene media pero no la descargamos aquí
      // para evitar uso excesivo de memoria en mensajes masivos
      simplifiedMessage.hasMedia = false;
    }
    return simplifiedMessage;
  }

  private checkCircuitBreaker(): boolean {
    if (this.circuitBreaker.isOpen) {
      if (Date.now() - this.circuitBreaker.lastFailure > this.CIRCUIT_BREAKER_TIMEOUT) {
        this.resetCircuitBreaker(); return true;
      }
      return false;
    }
    return true;
  }
  private resetCircuitBreaker() { this.circuitBreaker = { failures: 0, lastFailure: 0, isOpen: false }; }

  // ✅ CORRECCIÓN S6353: Usar \D en lugar de [^0-9]
  private toJid(number: string): string {
    if (number.includes('@s.whatsapp.net')) return number;
    return `${number.replaceAll(/\D/g, '')}@s.whatsapp.net`;
  }

  // Métodos de mensajería (Restaurados)
  async sendMessage(to: string, text: string): Promise<void> {
    if (!this.isReady) throw new Error('WhatsApp no conectado');
    const jid = this.toJid(to);
    await this.sock.sendMessage(jid, { text });
  }

  async sendTyping(to: string, durationMs: number = 2000) {
    if (!this.isReady) return;
    const jid = this.toJid(to);
    try {
      await this.sock.sendPresenceUpdate('composing', jid);
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      await this.sock.sendPresenceUpdate('paused', jid);
    } catch (e) {
      this.logger.warn(`Error enviando typing: ${e}`);
    }
  }

  async sendMedia(to: string, filePath: string, caption?: string): Promise<void> {
    if (!this.isReady) throw new Error('WhatsApp no conectado');

    const jid = this.toJid(to);
    const mimeType = lookup(filePath);

    if (!mimeType) throw new Error('Tipo de archivo desconocido');

    const messageOptions: any = { caption: caption || '' };

    if (mimeType.startsWith('image/')) {
      messageOptions.image = { url: filePath };
    } else if (mimeType.startsWith('video/')) {
      messageOptions.video = { url: filePath };
    } else if (mimeType.startsWith('audio/')) {
      messageOptions.audio = { url: filePath };
      messageOptions.mimetype = mimeType;
    } else {
      messageOptions.document = { url: filePath };
      messageOptions.mimetype = mimeType;
      messageOptions.fileName = path.basename(filePath);
    }

    await this.sock.sendMessage(jid, messageOptions);
  }

  // ✅ CORRECCIÓN: Bloques Try/Catch manejados correctamente
  async getBotProfile() {
    if (!this.isReady || !this.sock?.user) throw new Error('WhatsApp no listo');

    const botJid = jidNormalizedUser(this.sock.user.id);

    this.logger.log(`🔍 Debug: Buscando foto para JID Normalizado: ${botJid}`);

    let profilePicUrl = null;

    try {
      profilePicUrl = await this.sock.profilePictureUrl(botJid, 'image', 15000);
      this.logger.log('✅ Foto HD encontrada');
    } catch (error) {
      this.logger.warn(`⚠️ Error foto HD: ${error}`);
      try {
        profilePicUrl = await this.sock.profilePictureUrl(botJid, 'preview', 10000);
        this.logger.log('✅ Foto Preview encontrada');
      } catch (error_) { // ✅ S7718: Renombrado a error_
        this.logger.error(`❌ No se pudo obtener foto: ${error_}`);
      }
    }

    return {
      name: this.sock.user.name || this.sock.user.notify || 'Mi Bot',
      number: botJid.split('@')[0],
      profilePicUrl,
      isActive: this.isReady,
    };
  }

  async setProfilePicture(file: string | Buffer) {
    if (!this.isReady) throw new Error('WhatsApp no conectado');
    let buffer: Buffer;

    if (Buffer.isBuffer(file)) buffer = file;
    else if (typeof file === 'string') buffer = await fs.readFile(file);
    else throw new Error('Archivo inválido');

    const botJid = jidNormalizedUser(this.sock.user.id);
    await this.sock.updateProfilePicture(botJid, buffer);
  }

  async getContactInfo(contactId: string) {
    if (!this.isReady) throw new Error('WhatsApp no está conectado');
    const jid = this.toJid(contactId);
    try {
      const profilePicUrl = await this.sock.profilePictureUrl(jid, 'image').catch(() => null);
      return { id: jid, number: jid.split('@')[0], profilePicUrl, pushname: 'Usuario' };
    } catch (error) {
      this.logger.verbose(`No se pudo obtener info de contacto ${contactId}: ${error}`);
      return { id: jid, number: jid.split('@')[0], profilePicUrl: null, name: 'No disponible' };
    }
  }

  async setBotStatus(status: string) {
    await this.sock.updateProfileStatus(status);
  }

  getHealthStatus() {
    return {
      isReady: this.isReady,
      reconnectAttempts: this.reconnectAttempts,
      circuitBreaker: { isOpen: this.circuitBreaker.isOpen, failures: this.circuitBreaker.failures },
      maxReconnectAttempts: this.MAX_RECONNECT_ATTEMPTS,
    };
  }
}