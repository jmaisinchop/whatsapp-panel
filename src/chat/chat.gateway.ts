// src/chat/chat.gateway.ts - VERSIÓN CORREGIDA (SONARLINT S7773)

import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, Inject, forwardRef } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PresenceService } from './presence.service';
import { ChatService } from './chat.service';
import { Chat } from './entities/chat.entity';
import { OnEvent } from '@nestjs/event-emitter';

@WebSocketGateway({
  cors: { origin: '*' },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly presenceService: PresenceService,
    private readonly jwtService: JwtService,
    @Inject(forwardRef(() => ChatService))
    private readonly chatService: ChatService,
  ) { }

  // ✅ MÉTODO MODIFICADO PARA ASIGNAR CHATS PENDIENTES
  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth.token;
      if (!token) throw new Error('No se proporcionó token de autenticación');

      const payload = await this.jwtService.verifyAsync(token);
      
      // ✅ CORRECCIÓN: Usar Number.parseInt en lugar de parseInt global
      const userId = Number.parseInt(payload.sub, 10);

      (client as any).userId = userId;

      if (['agent', 'admin'].includes(payload.role)) {
        // Añadimos el rol a los datos del agente
        const agentData = { id: userId, firstName: payload.firstName, lastName: payload.lastName, email: payload.email, role: payload.role };
        this.presenceService.addAgent(client.id, agentData);
        this.broadcastPresenceUpdate();

        // Si el que se conecta es un 'agente', revisamos si hay chats en la cola
        if (payload.role === 'agent') {
          const waitingChatId = await this.chatService.getNextChatInQueue();
          if (waitingChatId) {
            this.logger.log(`¡Chat en espera #${waitingChatId} encontrado! Asignando al agente ${userId}.`);
            await this.chatService.assignChat(waitingChatId, userId, true);
          }
        }
      }

      this.logger.log(`Cliente autenticado y conectado: ${client.id}, UserID: ${userId}`);
    } catch (error) {
      this.logger.error('Error de autenticación de socket:', error.message);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.presenceService.removeAgent(client.id);
    this.broadcastPresenceUpdate();
    this.logger.log(`Cliente desconectado: ${client.id}`);
  }

  private broadcastPresenceUpdate() {
    const connectedAgents = this.presenceService.getConnectedAgents();
    this.server.emit('presenceUpdate', connectedAgents);
  }

  public broadcastDashboardUpdate() {
    this.server.emit('dashboard:surveyUpdate');
    this.logger.log('📢 Notificando al frontend: actualizar dashboard de encuestas.');
  }

  public broadcastNewInternalNote(chatId: number, note: any) {
    this.server.emit('chat:newInternalNote', { chatId, note });
    this.logger.log(`📢 Notificando nueva nota interna para el chat #${chatId}`);
  }

  notifyAssignmentToAgent(agentId: number, chat: Chat) {
    const socketId = this.presenceService.getSocketIdForAgent(agentId);
    if (socketId) {
      this.server.to(socketId).emit('assignment-notification', chat);
    }
  }

  sendNewMessage(payload: any) {
    this.server.emit('newMessage', payload);
  }

  notifyNewChat(chat: Chat) {
    this.server.emit('newChat', chat);
  }

  notifyAssignedChat(chat: Chat) {
    this.server.emit('assignedChat', chat);
  }

  notifyReleasedChat(chat: Chat) {
    this.server.emit('releasedChat', chat);
  }

  notifyFinalizedChat(chatId: number) {
    this.server.emit('finalizedChat', { chatId });
  }

  notifyMessagesRead(chatId: number, userId: number) {
    this.server.emit('messagesRead', { chatId, userId });
  }

  @OnEvent('whatsapp.qr')
  handleQrUpdate(qr: string) {
    // Enviamos el QR a todos los admins conectados
    this.server.emit('admin:qr', qr);
  }

  @OnEvent('whatsapp.status')
  handleStatusUpdate(payload: { status: string }) {
    this.server.emit('admin:status', payload);
  }
}