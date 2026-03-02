export class PolyticianError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends PolyticianError {
  constructor(resource: string, id: string) {
    super(`${resource} '${id}' not found`, 'NOT_FOUND');
  }
}

export class ValidationError extends PolyticianError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
  }
}

export class ConversionError extends PolyticianError {
  constructor(message: string, from?: string, to?: string) {
    const detail = from && to ? ` (${from} -> ${to})` : '';
    super(`${message}${detail}`, 'CONVERSION_ERROR');
  }
}

export class ConfigurationError extends PolyticianError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
  }
}
