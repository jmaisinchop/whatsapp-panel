// src/whatsapp/whatsapp.service.ts - VERSIÓN MEJORADA CON FIX PARA BAD MAC ERROR
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
  jidNormalizedUser,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as pino from 'pino';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as fs from 'node:fs/promises';
import { lookup } from 'mime-types';
import * as qrcode from 'qrcode-terminal';
import * as path from 'node:path';

export interface SimplifiedMessage {
  from: string;
  body: string;
  hasMedia: boolean;
  media?: {
    mimetype: string;
    data: Buffer;
  };
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

  // ✅ NUEVO: Contador de errores de sesión
  private sessionErrorCount = 0;
  private readonly MAX_SESSION_ERRORS = 10;
  private lastSessionErrorReset = Date.now();

  constructor(private readonly eventEmitter: EventEmitter2) { }

  async onModuleInit() {
    this.connectToWhatsApp();
  }

  async onModuleDestroy() {
    this.logger.log('[SHUTDOWN] Cerrando conexión con WhatsApp limpiamente...');
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
      this.logger.error('[SHUTDOWN] Error al cerrar WhatsApp:', error);
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
      this.logger.log('[LOGOUT] Logout manual solicitado');
      await this.sock.logout();
      await this.handleLogout();
    }
  }

  private async connectToWhatsApp() {
    if (this.sock) {
      try {
        this.logger.debug('[CLEANUP] Limpiando conexión socket anterior para evitar conflictos...');
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        this.sock.end(undefined);
        this.sock = null;
      } catch (error) {
        this.logger.warn('[CLEANUP] Error al limpiar socket anterior:', error);
      }
    }

    try {
      const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
      const { version } = await fetchLatestBaileysVersion();
      this.logger.log(`[INIT] Usando Baileys v${version.join('.')}`);

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
        // ✅ NUEVO: Configuración para manejar mejor las sesiones
        getMessage: async (key) => {
          // Retorna undefined para mensajes que no podemos recuperar
          // Esto evita intentos de desencriptación fallidos
          return undefined;
        },
      });

      this.setupEventHandlers(saveCreds);

    } catch (error) {
      this.logger.error('[INIT] Error fatal iniciando WhatsApp:', error);
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
        this.logger.log('[QR] QR Code generado.');
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
      this.logger.warn('[CONFLICT] Conflicto de sesión (440) detectado. Reintentando limpieza...');
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
    this.logger.warn('[LOGOUT] Sesión cerrada. Eliminando credenciales...');
    try {
      this.isReady = false;
      this.currentQR = null;
      await fs.rm('baileys_auth_info', { recursive: true, force: true });
      this.reconnectAttempts = 0;
      this.scheduleReconnect(5000);
      this.eventEmitter.emit('whatsapp.status', { status: 'disconnected' });
    } catch (error) {
      this.logger.error('[LOGOUT] Error eliminando credenciales:', error);
    }
  }

  private scheduleReconnect(delayMs?: number) {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      this.logger.error('[RECONNECT] Máximo de intentos de reconexión alcanzado.');
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectAttempts++;
    const delay = delayMs || Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
    
    this.logger.log(`[RECONNECT] Intento ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} en ${delay}ms`);
    
    this.reconnectTimer = setTimeout(() => {
      this.connectToWhatsApp();
    }, delay);
  }

  private handleSuccessfulConnection() {
    this.logger.log('[CONNECTED] Conexión con WhatsApp establecida correctamente');
    this.isReady = true;
    this.reconnectAttempts = 0;
    this.resetCircuitBreaker();
    this.eventEmitter.emit('whatsapp.status', { status: 'connected' });
    this.eventEmitter.emit('whatsapp.ready');
  }

  private setupCredentialsHandler(saveCreds: () => Promise<void>) {
    this.sock.ev.on('creds.update', saveCreds);
  }

  // ✅ MEJORADO: Handler de mensajes con manejo robusto de errores de sesión
  private setupMessagesHandler() {
    this.sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe || !msg.key.remoteJid.endsWith('@s.whatsapp.net')) return;

      try {
        const simplifiedMessage = await this.processIncomingMessage(msg);
        this.eventEmitter.emit('whatsapp.message', simplifiedMessage);
        
        // ✅ Resetear contador de errores de sesión en mensajes exitosos
        this.sessionErrorCount = 0;
        
      } catch (error) {
        // ✅ MANEJO ESPECÍFICO DE ERRORES DE SESIÓN/DESENCRIPTACIÓN
        if (this.isSessionError(error)) {
          this.handleSessionError(msg.key.remoteJid, error);
          return; // Ignorar este mensaje y continuar
        }
        
        this.logger.error('[MESSAGE] Error procesando mensaje:', error);
      }
    });
  }

  // ✅ NUEVO: Detectar errores de sesión
  private isSessionError(error: any): boolean {
    const errorMessage = error?.message?.toLowerCase() || '';
    const errorStack = error?.stack?.toLowerCase() || '';
    
    return (
      errorMessage.includes('bad mac') ||
      errorMessage.includes('decrypt') ||
      errorMessage.includes('session') ||
      errorStack.includes('verifymac') ||
      errorStack.includes('decryptwhispermessage')
    );
  }

  // ✅ NUEVO: Manejar errores de sesión
  private handleSessionError(remoteJid: string, error: any) {
    this.sessionErrorCount++;
    
    // Resetear contador cada 5 minutos
    if (Date.now() - this.lastSessionErrorReset > 300000) {
      this.sessionErrorCount = 0;
      this.lastSessionErrorReset = Date.now();
    }

    const contactNumber = remoteJid.split('@')[0];
    
    this.logger.warn(
      `[SESSION_ERROR] Error de desencriptación #${this.sessionErrorCount} para ${contactNumber}. ` +
      `Mensaje ignorado - la conversación continuará normalmente.`
    );

    // Si hay demasiados errores de sesión, podría indicar un problema mayor
    if (this.sessionErrorCount >= this.MAX_SESSION_ERRORS) {
      this.logger.error(
        `[SESSION_ERROR] Demasiados errores de sesión (${this.sessionErrorCount}). ` +
        `Esto podría indicar credenciales corruptas.`
      );
      
      // Opcionalmente, podrías forzar una reconexión aquí
      // this.logger.warn('[SESSION_ERROR] Considerando reconexión para limpiar sesiones...');
    }
  }

  private async processIncomingMessage(msg: any): Promise<SimplifiedMessage> {
    const from = msg.key.remoteJid;
    const messageContent = msg.message;
    const messageType = Object.keys(messageContent)[0];

    // Extraer el texto del mensaje
    const body = messageContent.conversation
      || messageContent.extendedTextMessage?.text
      || messageContent.imageMessage?.caption
      || messageContent.videoMessage?.caption
      || messageContent.documentMessage?.caption
      || '';

    // Tipos de mensaje que contienen media
    const mediaTypes = ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage'];
    const hasMedia = mediaTypes.includes(messageType);

    const simplifiedMessage: SimplifiedMessage = { from, body, hasMedia };

    // Descargar y procesar media si existe
    if (hasMedia) {
      try {
        this.logger.debug(`[MEDIA] Descargando ${messageType} de ${from}...`);
        
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          {
            logger: pino({ level: 'silent' }),
            reuploadRequest: this.sock.updateMediaMessage
          }
        );

        // Validar que el buffer sea válido
        if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
          this.logger.warn(`[MEDIA] Buffer inválido o vacío para ${messageType}`);
          simplifiedMessage.hasMedia = false;
          return simplifiedMessage;
        }

        // Validar tamaño del archivo
        if (buffer.length > this.MAX_FILE_SIZE) {
          this.logger.warn(`[MEDIA] Archivo demasiado grande (${buffer.length} bytes). Máximo: ${this.MAX_FILE_SIZE}`);
          simplifiedMessage.hasMedia = false;
          simplifiedMessage.body = body || '[Archivo demasiado grande - no procesado]';
          return simplifiedMessage;
        }

        // Obtener mimetype
        const mimetype = messageContent[messageType]?.mimetype 
          || 'application/octet-stream';

        simplifiedMessage.media = {
          mimetype,
          data: buffer
        };

        this.logger.log(`[MEDIA] Media descargado correctamente: ${mimetype}, ${buffer.length} bytes`);

      } catch (error) {
        this.logger.error(`[MEDIA] Error descargando media:`, error);
        simplifiedMessage.hasMedia = false;
        simplifiedMessage.body = body || '[Error descargando archivo adjunto]';
      }
    }

    return simplifiedMessage;
  }

  private checkCircuitBreaker(): boolean {
    if (this.circuitBreaker.isOpen) {
      if (Date.now() - this.circuitBreaker.lastFailure > this.CIRCUIT_BREAKER_TIMEOUT) {
        this.logger.log('[CIRCUIT_BREAKER] Reiniciando - timeout alcanzado');
        this.resetCircuitBreaker();
        return true;
      }
      this.logger.warn('[CIRCUIT_BREAKER] Abierto - rechazando operación');
      return false;
    }
    return true;
  }

  private recordFailure() {
    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailure = Date.now();

    if (this.circuitBreaker.failures >= this.CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitBreaker.isOpen = true;
      this.logger.error(`[CIRCUIT_BREAKER] Abierto después de ${this.circuitBreaker.failures} fallos`);
    }
  }

  private resetCircuitBreaker() {
    this.circuitBreaker = { failures: 0, lastFailure: 0, isOpen: false };
    this.logger.debug('[CIRCUIT_BREAKER] Reseteado');
  }

  private toJid(number: string): string {
    if (number.includes('@s.whatsapp.net')) return number;
    return `${number.replaceAll(/\D/g, '')}@s.whatsapp.net`;
  }

  async sendMessage(to: string, text: string): Promise<void> {
    if (!this.isReady) {
      const error = new Error('WhatsApp no conectado');
      this.recordFailure();
      throw error;
    }

    if (!this.checkCircuitBreaker()) {
      throw new Error('WhatsApp temporalmente no disponible (circuit breaker abierto)');
    }

    try {
      const jid = this.toJid(to);
      await this.sock.sendMessage(jid, { text });
      this.logger.debug(`[SEND] Mensaje enviado a ${to}`);
    } catch (error) {
      this.logger.error('[SEND] Error enviando mensaje:', error);
      this.recordFailure();
      throw error;
    }
  }

  async sendTyping(to: string, durationMs: number = 2000) {
    if (!this.isReady) return;
    const jid = this.toJid(to);
    try {
      await this.sock.sendPresenceUpdate('composing', jid);
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      await this.sock.sendPresenceUpdate('paused', jid);
    } catch (error) {
      this.logger.warn('[TYPING] Error enviando typing:', error);
    }
  }

  async sendMedia(to: string, filePath: string, caption?: string): Promise<void> {
    if (!this.isReady) {
      const error = new Error('WhatsApp no conectado');
      this.recordFailure();
      throw error;
    }

    if (!this.checkCircuitBreaker()) {
      throw new Error('WhatsApp temporalmente no disponible (circuit breaker abierto)');
    }

    try {
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
      this.logger.log(`[SEND_MEDIA] Archivo enviado: ${path.basename(filePath)}`);
    } catch (error) {
      this.logger.error('[SEND_MEDIA] Error enviando media:', error);
      this.recordFailure();
      throw error;
    }
  }

  async getBotProfile() {
    if (!this.isReady || !this.sock?.user) throw new Error('WhatsApp no listo');

    const botJid = jidNormalizedUser(this.sock.user.id);
    this.logger.log(`[PROFILE] Buscando foto para JID: ${botJid}`);

    let profilePicUrl = null;

    try {
      profilePicUrl = await this.sock.profilePictureUrl(botJid, 'image', 15000);
      this.logger.log('[PROFILE] Foto HD encontrada');
    } catch (error) {
      this.logger.warn('[PROFILE] Error foto HD:', error);
      try {
        profilePicUrl = await this.sock.profilePictureUrl(botJid, 'preview', 10000);
        this.logger.log('[PROFILE] Foto Preview encontrada');
      } catch (error_) {
        this.logger.error('[PROFILE] No se pudo obtener foto:', error_);
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

    if (Buffer.isBuffer(file)) {
      buffer = file;
    } else if (typeof file === 'string') {
      buffer = await fs.readFile(file);
    } else {
      throw new TypeError('Archivo inválido: debe ser Buffer o string');
    }

    const botJid = jidNormalizedUser(this.sock.user.id);
    await this.sock.updateProfilePicture(botJid, buffer);
  }

  async getContactInfo(contactId: string) {
    if (!this.isReady) throw new Error('WhatsApp no está conectado');
    const jid = this.toJid(contactId);
    try {
      const profilePicUrl = await this.sock.profilePictureUrl(jid, 'image').catch(() => null);
      return {
        id: jid,
        number: jid.split('@')[0],
        profilePicUrl,
        pushname: 'Usuario'
      };
    } catch (error) {
      this.logger.verbose(`[CONTACT] No se pudo obtener info de ${contactId}:`, error);
      return {
        id: jid,
        number: jid.split('@')[0],
        profilePicUrl: null,
        name: 'No disponible'
      };
    }
  }

  async setBotStatus(status: string) {
    await this.sock.updateProfileStatus(status);
  }

  getHealthStatus() {
    return {
      isReady: this.isReady,
      reconnectAttempts: this.reconnectAttempts,
      circuitBreaker: {
        isOpen: this.circuitBreaker.isOpen,
        failures: this.circuitBreaker.failures
      },
      maxReconnectAttempts: this.MAX_RECONNECT_ATTEMPTS,
      sessionErrors: this.sessionErrorCount, // ✅ NUEVO
    };
  }
}