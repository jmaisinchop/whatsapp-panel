// src/chat/chat.service.ts - VERSIÓN CORREGIDA COMPLETA
// =====================================================
// CORRECCIONES APLICADAS:
// ✅ 1. Validación de agentes conectados en assignChat
// ✅ 2. Race condition con Redis lock
// ✅ 3. Variable AGENT_RESPONSE_TIMEOUT_MS corregida
// ✅ 4. Cleanup de timers en OnModuleDestroy
// ✅ 5. Manejo de errores mejorado
// ✅ 6. N+1 query optimizado
// ✅ 7. Logging estructurado
// =====================================================

import { Injectable, Logger, forwardRef, Inject, NotFoundException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, DataSource } from 'typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Chat } from './entities/chat.entity';
import { Message } from './entities/message.entity';
import { InternalNote } from './entities/internal-note.entity';
import { WhatsappService, SimplifiedMessage } from '../whatsapp/whatsapp.service';
import { ChatGateway } from './chat.gateway';
import { UserService } from '../user/user.service';
import { ConversationFlowService } from '../conversation-flow/conversation-flow.service';
import { RedisStateStore } from '../conversation-flow/redis-state-store';
import { ConversationStep } from '../conversation-flow/conversation-state.enum';
import { ChatStatus } from '../common/enums/chat-status.enum';
import { MessageSender } from '../common/enums/message-sender.enum';
import { PresenceService } from './presence.service';
import { PaginationDto, PaginatedResponse } from './dto/pagination.dto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { lookup } from 'mime-types';

@Injectable()
export class ChatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatService.name);
  
  // Timers
  private readonly autoResponderTimeouts: Map<number, NodeJS.Timeout> = new Map();
  private readonly agentResponseTimeouts: Map<number, NodeJS.Timeout> = new Map();

  constructor(
    @InjectRepository(Chat) private readonly chatRepo: Repository<Chat>,
    @InjectRepository(Message) private readonly messageRepo: Repository<Message>,
    @InjectRepository(InternalNote) private readonly noteRepo: Repository<InternalNote>,
    @Inject(forwardRef(() => WhatsappService)) private readonly whatsappService: WhatsappService,
    @Inject(forwardRef(() => ChatGateway)) private readonly chatGateway: ChatGateway,
    private readonly userService: UserService,
    private readonly presenceService: PresenceService,
    private readonly conversationFlow: ConversationFlowService,
    private readonly configService: ConfigService,
    private readonly redisStore: RedisStateStore,
    private readonly dataSource: DataSource,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) { }

  // =====================================================
  // LIFECYCLE HOOKS
  // =====================================================

  onModuleInit() {
    const schedule = this.configService.get<string>('RELEASE_INACTIVE_CHATS_CRON_SCHEDULE', '0 0 */12 * * *');
    
    const job = new CronJob(schedule, () => {
      this.releaseLongActiveChats();
    });

    this.schedulerRegistry.addCronJob('releaseLongActiveChats', job as any);
    job.start();
    
    this.logger.log(`🕒 Cron 'releaseLongActiveChats' registrado: "${schedule}"`);
  }

  // ✅ NUEVO: Cleanup al destruir el módulo
  onModuleDestroy() {
    this.logger.log('🧹 Limpiando timers antes de destruir el servicio...');
    
    // Limpiar todos los timers
    this.autoResponderTimeouts.forEach((timer) => clearTimeout(timer));
    this.agentResponseTimeouts.forEach((timer) => clearTimeout(timer));
    
    this.autoResponderTimeouts.clear();
    this.agentResponseTimeouts.clear();
    
    this.logger.log('✅ Timers limpiados correctamente');
  }

  // =====================================================
  // MANEJO DE MENSAJES ENTRANTES
  // =====================================================

  @OnEvent('whatsapp.message')
  async handleIncomingMessage(message: SimplifiedMessage) {
    const contactNumber = message.from.split('@')[0];
    
    // ✅ CORRECCIÓN: Usar Redis para lock distribuido (evita race conditions)
    const lockKey = `chat:processing:${contactNumber}`;
    const lockAcquired = await this.redisStore.acquireLock(lockKey, 30000); // 30s lock
    
    if (!lockAcquired) {
      this.logger.debug(`🛡️ Mensaje ignorado: chat ${contactNumber} está siendo procesado por otra instancia`);
      return;
    }

    try {
      const now = new Date();
      let chat = await this.chatRepo.findOne({ 
        where: { contactNumber }, 
        relations: ['assignedTo'] 
      });

      if (chat) {
        if (chat.status !== ChatStatus.ACTIVE && chat.status !== ChatStatus.PENDING_ASSIGNMENT) {
           chat.status = ChatStatus.AUTO_RESPONDER;
           chat.assignedTo = null;
        }
        chat.updatedAt = now;
      } else {
        this.logger.log(`📝 Creando nuevo chat para: ${contactNumber}`);
        chat = this.chatRepo.create({
          contactNumber,
          customerName: null, 
          status: ChatStatus.AUTO_RESPONDER,
          unreadCount: 0,
          createdAt: now,
          updatedAt: now,
        });
      }

      await this.chatRepo.save(chat);
      await this.saveCustomerMessage(chat, message);

      // Verificar conexión de WhatsApp
      if (!this.whatsappService.isReady) {
        this.logger.warn(`⚠️ WhatsApp desconectado. Asignando chat #${chat.id} a asesor.`);
        await this.createSystemMessage(chat, 'Mensaje recibido sin conexión de WhatsApp. Asignando a asesor.');
        chat.status = ChatStatus.PENDING_ASSIGNMENT;
        await this.chatRepo.save(chat);
        await this.autoAssignChat(chat);
        return;
      }

      // Si está activo o pendiente, no hacer nada (agente lo maneja)
      if (chat.status === ChatStatus.ACTIVE || chat.status === ChatStatus.PENDING_ASSIGNMENT) {
        return;
      }

      // Flujo automático del bot
      if (chat.status === ChatStatus.AUTO_RESPONDER && !message.hasMedia) {
        this.startAutoResponderTimer(chat.id);
        
        try {
          const responseText = await this.conversationFlow.handleIncomingMessage(chat, message.body);

          if (responseText === '__ACTIVATE_CHAT_WITH_ADVISOR__') {
            await this.whatsappService.sendTyping(chat.contactNumber, 1500);
            await this.activateChatWithAdvisor(chat);
            
          } else if (responseText) {
            const humanDelay = Math.min(Math.max(responseText.length * 50, 1500), 7000);
            await this.whatsappService.sendTyping(chat.contactNumber, humanDelay);
            await this.sendBotMessage(chat, responseText);
          }
        } catch (error) {
          this.logger.error(`❌ Error en flujo chat #${chat.id}:`, error.stack);
          await this.whatsappService.sendTyping(chat.contactNumber, 2000);
          await this.sendBotMessage(chat, 'Tuve un problema técnico. Un asesor te contactará pronto.');
          await this.activateChatWithAdvisor(chat);
        }
      }

    } catch (error) {
      this.logger.error(`❌ Error crítico procesando mensaje de ${contactNumber}:`, error.stack);
    } finally {
      // ✅ IMPORTANTE: Liberar el lock
      await this.redisStore.releaseLock(lockKey);
    }
  }

  // =====================================================
  // GESTIÓN DE AGENTES
  // =====================================================

  private async activateChatWithAdvisor(chat: Chat) {
    chat.status = ChatStatus.ACTIVE;
    await this.chatRepo.save(chat);

    const handoffMessage = '¡Entendido! Uno de nuestros asesores se pondrá en contacto con usted lo más pronto posible. Por favor espere un momento. ⏳';
    await this.sendBotMessage(chat, handoffMessage);

    this.chatGateway.notifyNewChat(chat);
    await this.createSystemMessage(chat, 'Cliente solicitó asesor. Mensaje de espera enviado.');

    await this.autoAssignChat(chat);
  }

  private async autoAssignChat(chat: Chat) {
    const connectedAgents = this.presenceService.getConnectedAgents();
    const availableAgentIds = connectedAgents
      .filter(user => user.role === 'agent')
      .map(agent => agent.id);

    if (availableAgentIds.length === 0) {
      this.logger.warn(`⚠️ Sin agentes conectados. Chat #${chat.id} a cola de espera.`);
      chat.status = ChatStatus.PENDING_ASSIGNMENT;
      await this.chatRepo.save(chat);
      await this.redisStore.addChatToWaitingQueue(chat.id);
      await this.createSystemMessage(chat, 'Sin asesores disponibles. Chat en cola de espera.');
      this.chatGateway.notifyNewChat(chat);
      return;
    }

    const bestAgent = await this.userService.findAgentWithFewerChats(availableAgentIds);
    if (bestAgent) {
      await this.assignChat(chat.id, bestAgent.id, true);
    }
  }

  public async getNextChatInQueue(): Promise<number | null> {
    return this.redisStore.getNextChatInQueue();
  }

  // ✅ CORRECCIÓN: Validar que el agente esté conectado
  public async assignChat(chatId: number, agentId: number, isAutoAssignment = false) {
    const chat = await this.chatRepo.findOne({ where: { id: chatId } });
    if (!chat) {
      throw new NotFoundException('Chat no encontrado');
    }
    
    const agent = await this.userService.findById(agentId);
    if (!agent) {
      throw new NotFoundException('Agente no encontrado');
    }

    // ✅ VALIDACIÓN CRÍTICA: Verificar conexión del agente
    const connectedAgents = this.presenceService.getConnectedAgents();
    const isAgentConnected = connectedAgents.some(a => a.id === agentId);
    
    if (!isAgentConnected && !isAutoAssignment) {
      this.logger.warn(`⚠️ Intento de asignar chat #${chatId} a agente desconectado #${agentId}`);
      throw new Error('El agente no está conectado. No se puede asignar el chat.');
    }

    chat.assignedTo = agent;
    chat.status = ChatStatus.ACTIVE;
    await this.chatRepo.save(chat);

    const completeUpdatedChat = await this.findOne(chatId);

    this.chatGateway.notifyAssignedChat(completeUpdatedChat);
    this.chatGateway.notifyAssignmentToAgent(agentId, completeUpdatedChat);

    const assignmentType = isAutoAssignment ? 'automáticamente' : 'manualmente';
    await this.createSystemMessage(
      completeUpdatedChat, 
      `Chat asignado ${assignmentType} a: ${agent.firstName || agent.email}.`
    );

    this.startAgentResponseTimer(chat.id, agent.id);
    return completeUpdatedChat;
  }

  async sendAgentMessage(chatId: number, userId: number, content: string) {
    this.cancelAgentResponseTimer(chatId);
    
    const chat = await this.chatRepo.findOne({ 
      where: { id: chatId }, 
      relations: ['assignedTo'] 
    });
    
    if (!chat || chat.assignedTo?.id !== userId) {
      throw new Error('No tienes este chat asignado o no existe.');
    }
    
    const agentDisplayName = chat.assignedTo.firstName 
      ? `${chat.assignedTo.firstName}` 
      : `Agente`;
      
    const newMsg = this.messageRepo.create({ 
      chat, 
      sender: MessageSender.AGENT, 
      senderId: userId, 
      senderName: agentDisplayName, 
      content 
    });
    
    await this.messageRepo.save(newMsg);
    
    this.chatGateway.sendNewMessage({ chatId, message: newMsg, senderId: userId });
    
    // ✅ MEJORA: Manejo de errores en envío de WhatsApp
    try {
      await this.whatsappService.sendMessage(chat.contactNumber, content);
    } catch (error) {
      this.logger.error(`❌ Error enviando mensaje por WhatsApp:`, error);
      await this.createSystemMessage(chat, '⚠️ Error al enviar mensaje por WhatsApp. Intente nuevamente.');
      throw error;
    }
    
    return newMsg;
  }

  async releaseChat(chatId: number, sendSurvey = true) {
    this.cancelAgentResponseTimer(chatId);
    
    const chat = await this.chatRepo.findOne({ 
      where: { id: chatId }, 
      relations: ['assignedTo'] 
    });
    
    if (!chat) {
      throw new NotFoundException('Chat no encontrado');
    }
    
    const agentName = chat.assignedTo ? chat.assignedTo.firstName : 'un agente';
    
    chat.status = ChatStatus.AUTO_RESPONDER;
    chat.assignedTo = null;
    await this.chatRepo.save(chat);

    const completeUpdatedChat = await this.findOne(chatId);

    this.chatGateway.notifyReleasedChat(completeUpdatedChat);
    await this.createSystemMessage(completeUpdatedChat, `Chat liberado por ${agentName}.`);

    if (sendSurvey) {
      try {
        await this.whatsappService.sendTyping(chat.contactNumber, 2000);
        const surveyQuestion = 'Antes de finalizar, ¿podría calificar mi atención?\n\n1. Mala\n2. Regular\n3. Excelente\n\n(Por favor escriba el número)';
        await this.sendBotMessage(chat, surveyQuestion);
        
        const userState = await this.redisStore.getUserState(chat.contactNumber);
        userState.step = ConversationStep.SURVEY;
        await this.redisStore.setUserState(chat.contactNumber, userState);
      } catch (error) {
        this.logger.error(`❌ Error enviando encuesta:`, error);
      }
    }
    
    return completeUpdatedChat;
  }

  async unassignChat(chatId: number) {
    this.cancelAgentResponseTimer(chatId);
    
    const chat = await this.chatRepo.findOne({ 
      where: { id: chatId }, 
      relations: ['assignedTo'] 
    });
    
    if (!chat) {
      throw new NotFoundException('Chat no encontrado');
    }
    
    chat.status = ChatStatus.AUTO_RESPONDER;
    chat.assignedTo = null;
    await this.chatRepo.save(chat);

    const completeUpdatedChat = await this.findOne(chatId);

    await this.redisStore.resetUserState(completeUpdatedChat.contactNumber);
    this.chatGateway.notifyReleasedChat(completeUpdatedChat);
    await this.createSystemMessage(completeUpdatedChat, `Asignación removida.`);
    
    try {
      await this.whatsappService.sendTyping(completeUpdatedChat.contactNumber, 2000);
      const farewellMessage = 'Gracias por escribirnos. Si necesitas algo más, aquí estaré. ¡Hasta pronto! 👋';
      await this.sendBotMessage(completeUpdatedChat, farewellMessage);
    } catch (error) {
      this.logger.error(`❌ Error enviando mensaje de despedida:`, error);
    }
    
    return completeUpdatedChat;
  }

  // =====================================================
  // TIMERS
  // =====================================================

  private startAgentResponseTimer(chatId: number, agentId: number) {
    this.cancelAgentResponseTimer(chatId);
    
    // ✅ CORRECCIÓN: Usar variable correcta
    const timeoutMs = this.configService.get<number>(
      'AGENT_RESPONSE_TIMEOUT_MS', 
      300000 // 5 minutos default
    );
    
    this.logger.debug(`⏱️ Timer iniciado para chat #${chatId} - ${timeoutMs}ms`);
    
    const timer = setTimeout(() => {
      this.reassignUnansweredChat(chatId, agentId);
    }, timeoutMs);
    
    this.agentResponseTimeouts.set(chatId, timer);
  }

  private cancelAgentResponseTimer(chatId: number) {
    if (this.agentResponseTimeouts.has(chatId)) {
      clearTimeout(this.agentResponseTimeouts.get(chatId));
      this.agentResponseTimeouts.delete(chatId);
      this.logger.debug(`⏱️ Timer cancelado para chat #${chatId}`);
    }
  }

  private async reassignUnansweredChat(chatId: number, unresponsiveAgentId: number) {
    const chat = await this.chatRepo.findOne({ 
      where: { id: chatId }, 
      relations: ['assignedTo'] 
    });
    
    if (!chat || chat.status !== ChatStatus.ACTIVE || chat.assignedTo?.id !== unresponsiveAgentId) {
      return;
    }
    
    this.logger.warn(`⚠️ Agente ${unresponsiveAgentId} no respondió chat #${chatId}. Reasignando...`);
    
    const connectedAgents = this.presenceService.getConnectedAgents();
    const availableAgentIds = connectedAgents
      .filter(u => u.role === 'agent')
      .map(agent => agent.id);
      
    const nextBestAgent = await this.userService.findAgentWithFewerChats(
      availableAgentIds, 
      unresponsiveAgentId
    );
    
    if (nextBestAgent) {
      await this.assignChat(chat.id, nextBestAgent.id, true);
    } else {
      await this.releaseChat(chatId, false);
    }
  }

  private startAutoResponderTimer(chatId: number) {
    if (this.autoResponderTimeouts.has(chatId)) {
      clearTimeout(this.autoResponderTimeouts.get(chatId));
    }
    
    const timeoutMs = this.configService.get<number>(
      'AUTO_RESPONDER_TIMEOUT_MS', 
      1800000 // 30 min default
    );
    
    const timer = setTimeout(async () => {
      const chat = await this.chatRepo.findOneBy({ id: chatId });
      
      if (chat && chat.status === ChatStatus.AUTO_RESPONDER) {
        const currentState = await this.redisStore.getUserState(chat.contactNumber);
        
        if (currentState.step === ConversationStep.START) {
          this.autoResponderTimeouts.delete(chatId);
          return;
        }
        
        try {
          await this.whatsappService.sendTyping(chat.contactNumber, 2000);
          await this.sendBotMessage(
            chat, 
            'La sesión ha caducado por inactividad. Si necesita algo más, vuelva a escribirnos.'
          );
          await this.redisStore.resetUserState(chat.contactNumber);
        } catch (error) {
          this.logger.error(`❌ Error en timeout del auto-responder:`, error);
        }
      }
      
      this.autoResponderTimeouts.delete(chatId);
    }, timeoutMs);
    
    this.autoResponderTimeouts.set(chatId, timer);
  }

  // =====================================================
  // CONTADOR DE NO LEÍDOS
  // =====================================================

  private async incrementUnreadCount(chatId: number, amount: number = 1): Promise<void> {
    await this.chatRepo.increment({ id: chatId }, 'unreadCount', amount);
  }

  private async decrementUnreadCount(chatId: number, amount: number): Promise<void> {
    if (amount <= 0) return;
    
    await this.dataSource.query(
      `UPDATE chat SET "unreadCount" = GREATEST(0, "unreadCount" - $1) WHERE id = $2`,
      [amount, chatId]
    );
  }

  private async resetUnreadCount(chatId: number): Promise<void> {
    await this.chatRepo.update({ id: chatId }, { unreadCount: 0 });
  }

  // =====================================================
  // UTILIDADES
  // =====================================================

  private async createSystemMessage(chat: Chat, content: string) {
    const systemMsg = this.messageRepo.create({ 
      chat, 
      sender: MessageSender.SYSTEM, 
      content 
    });
    await this.messageRepo.save(systemMsg);
    this.chatGateway.sendNewMessage({ chatId: chat.id, message: systemMsg });
  }

  private async saveCustomerMessage(chat: Chat, message: SimplifiedMessage) {
    const messageData: Partial<Message> = {
      chat,
      sender: MessageSender.CUSTOMER,
      senderName: chat.customerName || chat.contactNumber,
      content: message.body,
      timestamp: new Date(),
    };

    if (message.hasMedia && message.media) {
      const randomName = crypto.randomBytes(16).toString('hex');
      const extension = lookup(message.media.mimetype);
      const filename = `${randomName}.${extension || 'bin'}`;
      const uploadsDir = path.join('./uploads');
      const filePath = path.join(uploadsDir, filename);

      try {
        await fs.mkdir(uploadsDir, { recursive: true });
        await fs.writeFile(filePath, message.media.data);
        messageData.mediaUrl = `/uploads/${filename}`;
        messageData.mimeType = message.media.mimetype;
        if (!messageData.content) {
          messageData.content = 'Archivo adjunto';
        }
      } catch (error) {
        this.logger.error(`❌ Error guardando archivo para ${chat.contactNumber}:`, error);
      }
    }

    const newMsg = this.messageRepo.create(messageData);
    await this.messageRepo.save(newMsg);
    
    await this.incrementUnreadCount(chat.id, 1);
    await this.chatRepo.save(chat);
    
    this.chatGateway.sendNewMessage({ chatId: chat.id, message: newMsg });
  }

  private async sendBotMessage(chat: Chat, text: string) {
    try {
      await this.whatsappService.sendMessage(chat.contactNumber, text);
      const botMsg = this.messageRepo.create({ 
        chat, 
        sender: MessageSender.BOT, 
        senderName: 'Kika', 
        content: text 
      });
      await this.messageRepo.save(botMsg);
      this.chatGateway.sendNewMessage({ chatId: chat.id, message: botMsg });
    } catch (error) {
      this.logger.error(`❌ Error enviando mensaje del bot:`, error);
      throw error;
    }
  }

  async sendMediaMessage(chatId: number, userId: number, file: Express.Multer.File, caption?: string) {
    const chat = await this.chatRepo.findOne({ 
      where: { id: chatId }, 
      relations: ['assignedTo'] 
    });
    
    if (!chat || chat.assignedTo?.id !== userId) {
      throw new Error('Chat no asignado');
    }
    
    try {
      await this.whatsappService.sendMedia(chat.contactNumber, file.path, caption);
      
      const agent = await this.userService.findById(userId);
      const agentName = agent.firstName || 'Agente';
      
      const newMsg = this.messageRepo.create({
        chat, 
        sender: MessageSender.AGENT, 
        senderId: userId, 
        senderName: agentName,
        content: caption || file.originalname, 
        mediaUrl: `/uploads/${file.filename}`, 
        mimeType: file.mimetype,
      });
      
      const savedMsg = await this.messageRepo.save(newMsg);
      this.chatGateway.sendNewMessage({ chatId, message: savedMsg, senderId: userId });
      
      return savedMsg;
    } catch (error) {
      this.logger.error(`❌ Error enviando media:`, error);
      
      // ✅ MEJORA: Limpiar archivo si falla el envío
      try {
        await fs.unlink(file.path);
        this.logger.log(`🗑️ Archivo ${file.filename} eliminado tras fallo de envío`);
      } catch (unlinkError) {
        this.logger.error(`❌ Error eliminando archivo:`, unlinkError);
      }
      
      throw error;
    }
  }

  async createInternalNote(chatId: number, authorId: number, content: string): Promise<InternalNote> {
    const chat = await this.chatRepo.findOneBy({ id: chatId });
    if (!chat) {
      throw new NotFoundException('Chat no encontrado');
    }

    const author = await this.userService.findById(authorId);
    if (!author) {
      throw new NotFoundException('Autor no encontrado');
    }

    const note = this.noteRepo.create({ content, chat, author });
    const savedNote = await this.noteRepo.save(note);

    this.chatGateway.broadcastNewInternalNote(chatId, savedNote);
    return savedNote;
  }

  async markMessagesAsRead(chatId: number) {
    return this.dataSource.transaction(async (transactionalEntityManager) => {
      const chat = await transactionalEntityManager.findOne(Chat, {
        where: { id: chatId },
        relations: ['messages'],
      });

      if (!chat) {
        throw new NotFoundException('Chat no encontrado');
      }

      const unreadMessages = chat.messages.filter(
        (m) => m.sender === MessageSender.CUSTOMER && m.readAt === null,
      );

      if (unreadMessages.length === 0) {
        return this.findOne(chatId);
      }

      for (const message of unreadMessages) {
        message.readAt = new Date();
      }

      await transactionalEntityManager.save(Message, unreadMessages);
      await transactionalEntityManager.update(Chat, chatId, { 
        unreadCount: 0,
        updatedAt: new Date() 
      });
      
      return this.findOne(chatId);
    });
  }

  // =====================================================
  // QUERIES OPTIMIZADAS
  // =====================================================

  async findAll(paginationDto: PaginationDto): Promise<PaginatedResponse<Chat>> {
    const { page = 1, limit = 50 } = paginationDto;
    const skip = (page - 1) * limit;

    // ✅ OPTIMIZACIÓN: Eager loading completo
    const [data, total] = await this.chatRepo
      .createQueryBuilder('chat')
      .leftJoinAndSelect('chat.assignedTo', 'assignedTo')
      .select([
        'chat.id',
        'chat.contactNumber',
        'chat.customerName',
        'chat.status',
        'chat.unreadCount',
        'chat.createdAt',
        'chat.updatedAt',
        'assignedTo.id',
        'assignedTo.firstName',
        'assignedTo.lastName',
        'assignedTo.email',
      ])
      .orderBy('chat.updatedAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    const totalPages = Math.ceil(total / limit);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  }

  async findOne(chatId: number) {
    // ✅ OPTIMIZACIÓN: Query única con todas las relaciones
    return this.chatRepo
      .createQueryBuilder('chat')
      .leftJoinAndSelect('chat.assignedTo', 'assignedTo')
      .leftJoinAndSelect('chat.messages', 'messages')
      .leftJoinAndSelect('chat.notes', 'notes')
      .leftJoinAndSelect('notes.author', 'author')
      .where('chat.id = :chatId', { chatId })
      .orderBy({ 
        'messages.id': 'ASC', 
        'notes.createdAt': 'ASC' 
      })
      .getOne();
  }

  async releaseLongActiveChats() {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const oldActiveChats = await this.chatRepo.find({ 
      where: { 
        status: ChatStatus.ACTIVE, 
        updatedAt: LessThan(twentyFourHoursAgo) 
      } 
    });
    
    if (oldActiveChats.length > 0) {
      this.logger.log(`🧹 Limpiando ${oldActiveChats.length} chats inactivos por más de 24h.`);
      
      for (const c of oldActiveChats) {
        try {
          await this.releaseChat(c.id, false);
        } catch (error) {
          this.logger.error(`❌ Error liberando chat #${c.id}:`, error);
        }
      }
    }
  }
}