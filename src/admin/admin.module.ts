import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { ChatModule } from 'src/chat/chat.module';
import { UserModule } from 'src/user/user.module';

@Module({
  imports: [WhatsappModule, ChatModule,UserModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}