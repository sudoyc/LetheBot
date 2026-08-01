import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getLogger } from '../logger/index.js';

const logger = getLogger();

export type ApplicationMetricsFormat = 'json' | 'prometheus';

export interface ApplicationHttpServerConfig {
  readonly host: string;
  readonly port: number;
  readonly healthPath: string;
  readonly readinessPath: string;
  readonly metricsPath: string;
  readonly eventPath: string;
  readonly reverseHttpIngressEnabled: boolean;
}

export interface ApplicationHttpServerHandlers {
  readonly handleHealth: (response: ServerResponse) => void;
  readonly handleReadiness: (response: ServerResponse) => void;
  readonly handleMetrics: (format: ApplicationMetricsFormat, response: ServerResponse) => void;
  readonly handleOneBotEvent: (request: IncomingMessage, response: ServerResponse) => void;
}

export class ApplicationHttpServer {
  private readonly server: Server;

  constructor(
    private readonly config: ApplicationHttpServerConfig,
    private readonly handlers: ApplicationHttpServerHandlers,
  ) {
    this.server = createServer(async (request, response) => {
      this.handleRequest(request, response);
    });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const handleListenError = (error: Error) => reject(error);
      this.server.once('error', handleListenError);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', handleListenError);
        this.logListenerCoordinates();
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const requestPath = requestUrl.pathname;

    if (requestPath === this.config.healthPath && request.method === 'GET') {
      this.handlers.handleHealth(response);
      return;
    }

    if (requestPath === this.config.readinessPath && request.method === 'GET') {
      this.handlers.handleReadiness(response);
      return;
    }

    if (requestPath === this.config.metricsPath && request.method === 'GET') {
      const format = requestUrl.searchParams.get('format') === 'prometheus'
        ? 'prometheus'
        : 'json';
      this.handlers.handleMetrics(format, response);
      return;
    }

    if (
      this.config.reverseHttpIngressEnabled
      && requestPath === this.config.eventPath
      && request.method === 'POST'
    ) {
      this.handlers.handleOneBotEvent(request, response);
      return;
    }

    response.writeHead(404);
    response.end('Not Found');
  }

  private logListenerCoordinates(): void {
    const { host, port } = this.config;
    logger.info({ host, port }, 'LetheBot listening');
    logger.info({ host: 'localhost', port, path: this.config.healthPath }, 'Health check');
    logger.info({ host: 'localhost', port, path: this.config.readinessPath }, 'Readiness check');
    logger.info({ host: 'localhost', port, path: this.config.metricsPath }, 'Metrics snapshot');
    if (this.config.reverseHttpIngressEnabled) {
      logger.info({ host: 'localhost', port, path: this.config.eventPath }, 'OneBot endpoint');
    }
  }
}
