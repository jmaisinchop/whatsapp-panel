import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Chat } from './entities/chat.entity';
import { Message } from './entities/message.entity';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { UserModule } from '../user/user.module';
import { ConversationFlowService } from 'src/conversation-flow/conversation-flow.service';
import { RedisStateStore } from 'src/conversation-flow/redis-state-store';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PresenceService } from './presence.service';
import { JwtModule } from '@nestjs/jwt'; 
import { ContactsController } from './contacts.controller'; 
import { SurveyResponse } from './entities/survey-response.entity';
import { InternalNote } from './entities/internal-note.entity';
import { DashboardModule } from '../dashboard/dashboard.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Chat, Message, SurveyResponse, InternalNote]),
    forwardRef(() => WhatsappModule),
    forwardRef(() => DashboardModule),
    UserModule,
    ScheduleModule.forRoot(),
    ConfigModule,
    
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { 
          expiresIn: configService.get<string>('JWT_EXPIRES_IN', '24h') as any  // ✅ FIX
        },
      }),
    }),
  ],
  providers: [
    ChatService,
    ChatGateway,
    ConversationFlowService,
    RedisStateStore,
    PresenceService,
  ],
  controllers: [ChatController, ContactsController],
  exports: [ChatService, PresenceService, ChatGateway],
})
export class ChatModule {}