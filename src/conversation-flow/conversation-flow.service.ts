import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Chat } from '../chat/entities/chat.entity';
import { RedisStateStore } from './redis-state-store';
import { ConversationStep } from './conversation-state.enum';
import { UserState } from './conversation-flow.interface';
import { SurveyResponse, SurveyRating } from '../chat/entities/survey-response.entity';
import { ChatGateway } from '../chat/chat.gateway';
import { DashboardService } from '../dashboard/dashboard.service';
import { ChatService } from '../chat/chat.service';

@Injectable()
export class ConversationFlowService {
  private readonly logger = new Logger(ConversationFlowService.name);

  constructor(
    @InjectRepository(SurveyResponse)
    private readonly surveyResponseRepo: Repository<SurveyResponse>,
    @Inject(forwardRef(() => ChatGateway))
    private readonly chatGateway: ChatGateway,
    @Inject(forwardRef(() => DashboardService))
    private readonly dashboardService: DashboardService,
    @Inject(forwardRef(() => ChatService))
    private readonly chatService: ChatService,
    private readonly redisStore: RedisStateStore,
    private readonly dataSource: DataSource,
  ) { }

  public async handleIncomingMessage(chat: Chat, rawText: string): Promise<string> {
    const contactNumber = chat.contactNumber;
    let userState = await this.redisStore.getUserState(contactNumber);
    const freshChat = await this.dataSource.getRepository(Chat).findOneBy({ id: chat.id });
    
    const text = rawText.trim();
    const lowerText = text.toLowerCase();

    // Manejo de comandos de salida
    const exitResponse = this.handleExitCommands(lowerText, userState, freshChat);
    if (exitResponse) {
      if (exitResponse.newStep) {
        userState.step = exitResponse.newStep;
        userState.termsAccepted = exitResponse.resetTerms ? false : userState.termsAccepted;
        await this.redisStore.setUserState(contactNumber, userState);
      }
      return exitResponse.message;
    }

    // Manejo de encuesta
    if (userState.step === ConversationStep.SURVEY) {
      return await this.handleSurvey(chat, text);
    }

    // Proceso principal por pasos
    const responseText = await this.processConversationStep(
      userState,
      text,
      lowerText,
      freshChat,
      contactNumber
    );

    await this.redisStore.setUserState(contactNumber, userState);
    return responseText;
  }

  // --- MANEJO DE COMANDOS DE SALIDA ---
  private handleExitCommands(
    lowerText: string,
    userState: UserState,
    freshChat: Chat
  ): { message: string; newStep?: ConversationStep; resetTerms?: boolean } | null {
    const exitCommands = ['salir', 'chao', 'adios', 'fin', 'terminar', 'cancelar', '0', 'menu', 'inicio'];
    
    if (!exitCommands.includes(lowerText)) {
      return null;
    }

    // Si pide menú estando en menú
    if (userState.step === ConversationStep.MAIN_MENU && ['menu', 'inicio', '0'].includes(lowerText)) {
      return { message: this.getMainMenuText(freshChat.customerName) };
    }

    // Si pide salir definitivamente
    if (['salir', 'chao', 'adios', 'fin', 'terminar'].includes(lowerText)) {
      return {
        message: this.getSurveyQuestion(),
        newStep: ConversationStep.SURVEY
      };
    }

    // Reset general
    return {
      message: '¡Entendido! Regresamos al menú principal 🏠.\n\n' + this.getMainMenuText(freshChat.customerName, false),
      newStep: ConversationStep.MAIN_MENU,
      resetTerms: true
    };
  }

  // --- PROCESO DE PASOS ---
  private async processConversationStep(
    userState: UserState,
    text: string,
    lowerText: string,
    freshChat: Chat,
    contactNumber: string
  ): Promise<string> {
    switch (userState.step) {
      case ConversationStep.START: {
        return this.handleStartStep(userState, freshChat);
      }

      case ConversationStep.ASK_FOR_NAME: {
        return await this.handleNameStep(userState, text, freshChat);
      }

      case ConversationStep.MAIN_MENU: {
        return this.handleMainMenuStep(userState, text, lowerText, freshChat);
      }

      case ConversationStep.DISCLAIMER: {
        return this.handleDisclaimerStep(userState, lowerText);
      }

      case ConversationStep.PEDIR_CEDULA: {
        return await this.handleCedulaStep(userState, text, freshChat);
      }

      default: {
        userState.step = ConversationStep.MAIN_MENU;
        return '¡Ups! 😅 Me confundí un poco. Mejor empecemos de nuevo.\n\n' + this.getMainMenuText(freshChat.customerName);
      }
    }
  }

  // --- HANDLERS ESPECÍFICOS ---

  private handleStartStep(userState: UserState, freshChat: Chat): string {
    if (freshChat.customerName) {
      userState.step = ConversationStep.MAIN_MENU;
      // Saludo personalizado Kika
      return this.getMainMenuText(freshChat.customerName, true); 
    }

    userState.step = ConversationStep.ASK_FOR_NAME;
    return `${this.getTimeGreeting()} 👋 Soy Kika, tu asistente virtual.\n\nPara brindarte una mejor atención, ¿podrías indicarme tu nombre, por favor?`;
  }

  private async handleNameStep(userState: UserState, text: string, freshChat: Chat): Promise<string> {
    if (text.length < 3 || /\d/.test(text)) {
      return 'Mmm... ese nombre no parece válido 🤔. Por favor, escribe solo tu nombre real para continuar.';
    }

    freshChat.customerName = text;
    await this.dataSource.getRepository(Chat).save(freshChat);
    
    userState.step = ConversationStep.MAIN_MENU;
    // Ya tenemos nombre, mostramos menú completo
    return this.getMainMenuText(text, true);
  }

  private handleMainMenuStep(userState: UserState, text: string, lowerText: string, freshChat: Chat): string {
    const isConsultOption = text === '1' || lowerText.includes('consultar') || lowerText.includes('deuda');
    const isAdvisorOption = text === '2' || lowerText.includes('asesor') || lowerText.includes('agente');

    if (isConsultOption) {
      if (userState.termsAccepted) {
        userState.step = ConversationStep.PEDIR_CEDULA;
        return '¡Perfecto! 👌 Por favor, ingresa tu número de cédula para realizar la consulta.';
      }

      userState.step = ConversationStep.DISCLAIMER;
      return 'Antes de mostrarte información privada 🔒, necesito que aceptes nuestros Términos y Condiciones: https://www.finsolred.com/terminos-y-condiciones-uso-del-chatbot\n\n¿Estás de acuerdo? (Responde "Sí" o "No")';
    }

    if (isAdvisorOption) {
      return '__ACTIVATE_CHAT_WITH_ADVISOR__';
    }

    return 'No entendí esa opción 😅. Por favor, elige una de las siguientes:\n\n' + this.getMainMenuText(freshChat.customerName, false);
  }

  private handleDisclaimerStep(userState: UserState, lowerText: string): string {
    const acceptTerms = ['si', 'sí', 'acepto', 'ok', 'claro', 'dele'].includes(lowerText);
    const rejectTerms = ['no', 'rechazo', 'nunca', 'jamás'].includes(lowerText);

    if (acceptTerms) {
      userState.termsAccepted = true;
      userState.step = ConversationStep.PEDIR_CEDULA;
      return '¡Gracias por confirmar! ✅\n\nAhora sí, escríbeme tu número de cédula para buscar tus deudas.';
    }

    if (rejectTerms) {
      userState.step = ConversationStep.MAIN_MENU;
      return 'Comprendo. Respetamos tu privacidad, pero sin tu autorización no puedo mostrarte la información 🛡️.\n\n' + this.getMainMenuText(undefined, false);
    }

    return 'Necesito una confirmación clara. Por favor responde "Sí" para continuar o "No" para cancelar.';
  }

  private async handleCedulaStep(userState: UserState, text: string, freshChat: Chat): Promise<string> {
    const idInput = text.trim();

    if (idInput.length < 5) {
      return 'El número parece muy corto. Por favor verifica e intenta nuevamente.';
    }

    const client = await this.findClientById(idInput);

    if (client) {
      return await this.buildClientDebtResponse(client, idInput, freshChat, userState);
    }

    userState.step = ConversationStep.MAIN_MENU;
    return `Busqué en el sistema 🔎, pero no encontré registros con la cédula *${idInput}*.\n\n¿Deseas intentar otra vez?\n` + this.getMainMenuText(freshChat.customerName, false);
  }

  private async buildClientDebtResponse(
    client: any,
    idInput: string,
    freshChat: Chat,
    userState: UserState
  ): Promise<string> {
    const deudasTexto = await this.mostrarListaEmpresas(idInput);
    let responseText: string;

    if (deudasTexto.includes("Buenas noticias")) {
      responseText = `¡Estimado/a ${freshChat.customerName}, te tengo buenas noticias! 🎉\n\n*No registras deudas pendientes con nosotros.*`;
    } else {
      responseText = `Hola ${client.nombre}, aquí tienes tu estado de cuenta 📄:\n\n${deudasTexto}`;
    }

    userState.step = ConversationStep.MAIN_MENU;
    return responseText + `\n💡 *Tip:* Si necesitas detalles específicos, la opción 2 te conecta con un humano.\n\n${this.getMainMenuText(freshChat.customerName, false)}`;
  }

  // --- GENERACIÓN DE MENÚS Y TEXTOS AMIGABLES (LÓGICA KIKA) ---

  /**
   * Genera el menú principal con formato limpio y emojis.
   * @param name Nombre del cliente (opcional)
   * @param includeIntro Si es true, agrega el saludo "Soy Kika..." al inicio.
   */
  private getMainMenuText(name?: string, includeIntro: boolean = true): string {
    let mensaje = '';

    // 1. Saludo inicial (Opcional)
    if (includeIntro) {
        mensaje += `¡${this.getTimeGreeting()}, ${name || ''}! Soy Kika 🤖.\n`;
        mensaje += `Es un gusto saludarte. ¿En qué puedo ayudarte hoy?\n\n`;
    } else {
        mensaje += name ? `¿En qué más te puedo ayudar, ${name}? 👇` : 'Aquí tienes tus opciones:';
        mensaje += '\n\n';
    }

    // 2. Definición de opciones "sucias" (como vienen del sistema o hardcodeadas)
    // NOTA: Aquí quitamos los [DOC] para procesarlos, o los dejamos si quieres mantener la estructura original
    // Para simplificar, aquí construyo el menú limpio directamente:
    
    mensaje += '1️⃣ Consultar Deudas\n';
    mensaje += '2️⃣ Hablar con un asesor\n';

    // 3. Footer
    mensaje += '\n💡 _(Escribe "Salir" para terminar)_';

    return mensaje;
  }

  private getTimeGreeting(): string {
    const hour = new Date().getHours(); 
    if (hour >= 5 && hour < 12) return 'Buenos días';
    if (hour >= 12 && hour < 19) return 'Buenas tardes';
    return 'Buenas noches';
  }

  // --- ENCUESTA ---

  private getSurveyQuestion(): string {
    return 'Antes de irte, ¿me regalas 5 segundos? ⏱️\n\n¿Cómo calificarías mi atención hoy?\n\n1️⃣ Mala\n2️⃣ Regular\n3️⃣ Excelente!\n\n_(Solo escribe el número)_';
  }

  private async handleSurvey(chat: Chat, text: string): Promise<string> {
    const choice = text.trim().toLowerCase();
    let rating: SurveyRating | null = null;
    let comment: string | null = null;

    if (choice.includes('1') || choice.includes('mala')) {
      rating = SurveyRating.MALA;
    } else if (choice.includes('2') || choice.includes('regular')) {
      rating = SurveyRating.REGULAR;
    } else if (choice.includes('3') || choice.includes('excelente')) {
      rating = SurveyRating.EXCELENTE;
    } else {
      comment = text;
    }

    if (rating) {
      try {
        const surveyData = this.surveyResponseRepo.create({ chat, rating, comment });
        await this.surveyResponseRepo.save(surveyData);
        
        await this.dashboardService.invalidateSurveyCache();
        this.chatGateway.broadcastDashboardUpdate();
        
        this.logger.log(`[SURVEY] Encuesta guardada: ${rating} - Caché invalidado`);
        
        await this.chatService.finalizeChat(chat.id);
        
      } catch (error) {
        this.logger.error('[SURVEY] Error guardando encuesta:', error);
      }
    }

    await this.redisStore.resetUserState(chat.contactNumber);
    return '¡Muchas gracias por tu opinión! 🙌 Que tengas un día genial. Kika se despide.';
  }

  // --- LOGICA DE BASE DE DATOS (INTACTA) ---

  private async findClientById(id: string) {
    try {
      const query = 'SELECT "id", "cedula", "nombre" FROM "cb_car_cliente" WHERE "cedula" = $1';
      const result = await this.dataSource.query(query, [id]);
      return result.length > 0 ? result[0] : null;
    } catch (error) { 
      this.logger.error('[DB] Error SQL cliente:', error); 
      return null; 
    }
  }

  private async mostrarListaEmpresas(id: string): Promise<string> {
    try {
      const query = 'SELECT cc.id, cc.carterapropia, ccc2.descripcion ' +
        'FROM cb_car_cliente ccc ' +
        'JOIN cb_car_cliente_contratocobranza cccc ON ccc.id = cccc.cb_car_cliente_id ' +
        'JOIN contratocobranza cc ON cccc.listacontratocobranza_id = cc.id ' +
        'JOIN cb_car_cartera ccc2 ON cc.carteracb_id = ccc2.id ' +
        'WHERE ccc.cedula = $1 AND cc.cubre = false AND cc.antiguo = false';

      const rows = await this.dataSource.query(query, [id]);
      if (rows.length === 0) {
        return `Buenas noticias! No encontré deudas pendientes registradas para la identificación ${id}.`;
      }
      
      const promesas = rows.map(row => this.obtenerDetalleDeuda(row));
      const detalles = await Promise.all(promesas);

      let respuesta = "";
      detalles.forEach(d => respuesta += d);

      return respuesta;
    } catch (error) { 
      this.logger.error(`[DB] Error en mostrarListaEmpresas: ${error.message}`); 
      return 'Ocurrió un error al consultar sus deudas.'; 
    }
  }

  private async obtenerDetalleDeuda(deuda: any): Promise<string> {
    try {
      const contratoId = deuda.id;
      const carteraPropia = deuda.carterapropia;
      let mensaje = `💰 Deuda con *${this.mapEncabezado(deuda.descripcion)}*:\n`;
      let foundDetails = false;

      if (carteraPropia) {
        const query = 'SELECT d.valorpagado AS valor_liquidacion, d.valortotaldeuda, p.descripcion ' +
          'FROM contratocobranza cc ' +
          'JOIN contratocobranza_datoscobranza cd ON cc.id = cd.contratocobranza_id ' +
          'JOIN datoscobranza d ON cd.datoscobranzas_id = d.id ' +
          'JOIN productocobranza p ON d.productocobranza_id = p.id ' +
          'WHERE cc.id = $1 AND cc.carterapropia = true';
        const result = await this.dataSource.query(query, [contratoId]);
        if (result.length > 0) {
          foundDetails = true;
          for (const r of result) {
            mensaje += `   ▪️ Producto: ${r.descripcion || 'No especificado'}\n`;
            mensaje += `   ▪️ Valor Total: $${Number(r.valortotaldeuda).toFixed(2)}\n`;
            mensaje += `   ▪️ Valor Liquidación: $${Number(r.valor_liquidacion).toFixed(2)}\n`;
          }
        }
      } else {
        const query = 'SELECT d.pagominimo, p.descripcion ' +
          'FROM contratocobranza cc ' +
          'JOIN contratocobranza_datoscobranza cd ON cc.id = cd.contratocobranza_id ' +
          'JOIN datoscobranza d ON cd.datoscobranzas_id = d.id ' +
          'JOIN productocobranza p ON d.productocobranza_id = p.id ' +
          'WHERE cc.id = $1 AND cc.carterapropia = false and cc.antiguo = false';
        const result = await this.dataSource.query(query, [contratoId]);
        if (result.length > 0) {
          foundDetails = true;
          for (const r of result) {
            mensaje += `   ▪️ Producto: ${r.descripcion || 'No especificado'}\n`;
            mensaje += `   ▪️ Deuda al corte: $${Number(r.pagominimo).toFixed(2)}\n`;
          }
        }
      }
      return foundDetails ? mensaje + '\n' : '';
    } catch (error) {
      this.logger.error('[DB] Error en obtenerDetalleDeuda:', error);
      return 'Ocurrió un problema al consultar el detalle de esta deuda.\n';
    }
  }

  private mapEncabezado(desc: string): string {
    const d = (desc || '').toUpperCase();
    if (d.includes('BANCO DEL AUSTRO')) return 'BANCO DEL AUSTRO';
    if (d.includes('PACIFICO')) return 'BANCO DEL PACÍFICO';
    if (d.includes('GUAYAQUIL')) return 'BANCO GUAYAQUIL';
    if (d.includes('PICHINCHA')) return 'BANCO PICHINCHA';
    if (d.includes('COOP SANTA')) return 'COOP SANTA ROSA';
    if (d.includes('EL BOSQUE')) return 'MUEBLES EL BOSQUE';
    if (d.includes('JAHER')) return 'JAHER';
    if (d.includes('MARCIMEX')) return 'MARCIMEX';
    if (d.includes('MASTER MOTO')) return 'MASTER MOTO';
    return desc || 'EMPRESA';
  }
}