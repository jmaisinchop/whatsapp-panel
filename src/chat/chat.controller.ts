// src/chat/chat.controller.ts - VERSIÓN CORREGIDA CON PAGINACIÓN DE MENSAJES
import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ParseIntPipe,
  UseInterceptors,
  UploadedFile,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ChatService } from './chat.service';
import { AuthGuard } from '@nestjs/passport';
import { ChatGateway } from './chat.gateway';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { Roles } from 'src/auth/guards/roles.decorator';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { PaginationDto } from './dto/pagination.dto';
import * as crypto from 'node:crypto';
import { extname } from 'node:path';

@Controller('chats')
@UseGuards(AuthGuard('jwt'))
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
  ) {}

  @Get()
  findAll(@Query() paginationDto: PaginationDto) {
    return this.chatService.findAll(paginationDto);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.chatService.findOne(id);
  }

  // ✅ NUEVO ENDPOINT: Obtener mensajes paginados de un chat
  @Get(':id/messages')
  getMessages(
    @Param('id', ParseIntPipe) chatId: number,
    @Query('page', ParseIntPipe) page: number = 1,
    @Query('limit', ParseIntPipe) limit: number = 50,
  ) {
    if (limit > 100) {
      throw new BadRequestException('El límite máximo es 100 mensajes por página');
    }
    return this.chatService.getChatMessages(chatId, page, limit);
  }

  @Patch(':id/read')
  async markAsRead(@Param('id', ParseIntPipe) chatId: number, @Request() req) {
    const userId = req.user.userId;
    const updatedChat = await this.chatService.markMessagesAsRead(chatId);
    this.chatGateway.notifyMessagesRead(chatId, userId);
    return updatedChat;
  }

  @Post(':id/message')
  async sendMsg(
    @Param('id', ParseIntPipe) id: number,
    @Request() req,
    @Body() body: { content: string },
  ) {
    const userId = req.user.userId;
    return this.chatService.sendAgentMessage(id, userId, body.content);
  }

  @Post(':id/media')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads',
        filename: (req, file, cb) => {
          const randomName = crypto.randomBytes(16).toString('hex');
          const fileExt = extname(file.originalname).toLowerCase();
          cb(null, `${randomName}${fileExt}`);
        },
      }),
      limits: {
        fileSize: 50 * 1024 * 1024,
        files: 1,
      },
      fileFilter: (req, file, cb) => {
        const allowedMimeTypes = [
          'image/jpeg',
          'image/jpg',
          'image/png',
          'image/gif',
          'image/webp',
          'video/mp4',
          'video/mpeg',
          'video/quicktime',
          'video/x-msvideo',
          'audio/mpeg',
          'audio/mp3',
          'audio/ogg',
          'audio/wav',
          'audio/webm',
          'application/pdf',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'text/plain',
          'text/csv',
        ];

        if (!allowedMimeTypes.includes(file.mimetype)) {
          return cb(
            new BadRequestException(
              `Tipo de archivo no permitido: ${file.mimetype}. ` +
              `Tipos permitidos: imágenes, videos, audio, PDF, documentos Office.`
            ),
            false,
          );
        }

        const allowedExtensions = [
          '.jpg', '.jpeg', '.png', '.gif', '.webp',
          '.mp4', '.mpeg', '.mov', '.avi',
          '.mp3', '.ogg', '.wav', '.webm',
          '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv',
        ];

        const fileExt = extname(file.originalname).toLowerCase();
        if (!allowedExtensions.includes(fileExt)) {
          return cb(
            new BadRequestException(
              `Extensión de archivo no permitida: ${fileExt}`
            ),
            false,
          );
        }

        if (file.originalname.includes('..') || file.originalname.includes('/')) {
          return cb(
            new BadRequestException('Nombre de archivo inválido'),
            false,
          );
        }

        cb(null, true);
      },
    }),
  )
  async sendMedia(
    @Param('id', ParseIntPipe) id: number,
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { caption?: string },
  ) {
    if (!file) {
      throw new BadRequestException('No se proporcionó ningún archivo');
    }

    const userId = req.user.userId;
    return this.chatService.sendMediaMessage(id, userId, file, body.caption);
  }

  @Patch(':id/release')
  async release(@Param('id', ParseIntPipe) id: number) {
    const chat = await this.chatService.releaseChat(id);
    this.chatGateway.notifyReleasedChat(chat);
    return chat;
  }

  @Patch(':id/assign')
  async assignChat(
    @Param('id', ParseIntPipe) chatId: number,
    @Request() req,
    @Body() body: { agentId?: number },
  ) {
    const loggedInUser = req.user;

    if (body.agentId && body.agentId !== loggedInUser.userId && loggedInUser.role !== 'admin') {
      throw new ForbiddenException('Solo los administradores pueden asignar chats a otros agentes.');
    }

    const agentIdToAssign = body.agentId ?? loggedInUser.userId;

    return this.chatService.assignChat(chatId, agentIdToAssign);
  }

  @Patch(':id/unassign')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async unassign(@Param('id', ParseIntPipe) id: number) {
    const chat = await this.chatService.unassignChat(id);
    return chat;
  }

  @Post(':id/notes')
  async createNote(
    @Param('id', ParseIntPipe) chatId: number,
    @Request() req,
    @Body() body: { content: string },
  ) {
    const authorId = req.user.userId;
    return this.chatService.createInternalNote(chatId, authorId, body.content);
  }
}