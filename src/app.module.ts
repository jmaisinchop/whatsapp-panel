// src/app.module.ts - VERSIÓN FINAL CON TODAS LAS OPTIMIZACIONES

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '@nestjs/cache-manager';
import { redisStore } from 'cache-manager-redis-store';
import type { RedisClientOptions } from 'redis';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { ChatModule } from './chat/chat.module';
import { AdminModule } from './admin/admin.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { EventEmitterModule } from '@nestjs/event-emitter';

@Module({
  imports: [
    // =====================================================
    // EVENT EMITTER
    // =====================================================
    EventEmitterModule.forRoot(),

    // =====================================================
    // CONFIGURACIÓN GLOBAL
    // =====================================================
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.test', '.env.production'],
    }),

    // =====================================================
    // ✅ CACHÉ REDIS (FASE 3)
    // =====================================================
    CacheModule.registerAsync<RedisClientOptions>({
      isGlobal: true, // Disponible en todos los módulos
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const redisUrl = configService.get<string>('REDIS_URL', 'redis://localhost:6379');
        
        return {
          store: redisStore as any,
          url: redisUrl,
          ttl: 300, // TTL por defecto: 5 minutos (300 segundos)
          max: 100, // Máximo 100 items en caché
          socket: {
            reconnectStrategy: (retries: number) => {
              // Reintentar cada 3 segundos, máximo 10 veces
              if (retries > 10) {
                console.error('❌ Redis: Máximo de reintentos alcanzado');
                return new Error('Redis desconectado');
              }
              console.log(`🔄 Redis: Reintentando conexión (${retries}/10)...`);
              return 3000; // Reintentar cada 3 segundos
            },
          },
        };
      },
    }),

    // =====================================================
    // BASE DE DATOS POSTGRESQL
    // =====================================================
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST'),
        port: configService.get<number>('DB_PORT'),
        username: configService.get<string>('DB_USERNAME'),
        password: configService.get<string>('DB_PASSWORD'),
        database: configService.get<string>('DB_NAME'),
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        //synchronize: true,
        
        // ✅ CONNECTION POOL MEJORADO (FASE 3)
        extra: {
          options: `-c timezone=America/Guayaquil`,
          max: 30, // ← AUMENTADO: Máximo 30 conexiones (antes 20)
          min: 5,  // ← AUMENTADO: Mínimo 5 conexiones (antes 2)
          idleTimeoutMillis: 30000, // Cerrar conexiones inactivas después de 30s
          connectionTimeoutMillis: 5000, // Timeout de conexión: 5s
        },
      }),
    }),

    // =====================================================
    // MÓDULOS DE LA APLICACIÓN
    // =====================================================
    AuthModule,
    UserModule,
    WhatsappModule,
    ChatModule,
    AdminModule,
    DashboardModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}