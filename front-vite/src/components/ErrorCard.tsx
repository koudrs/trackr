import { AlertCircle, RefreshCw, X } from "lucide-react";

interface ErrorCardProps {
  awb: string;
  error: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  isRetrying?: boolean;
}

export function ErrorCard({ awb, error, onRetry, onDismiss, isRetrying }: ErrorCardProps) {
  // Parse error for better display
  const getErrorInfo = (err: string) => {
    if (err.includes("No se encontró")) {
      return {
        title: "AWB no encontrado",
        description: "El número de guía no existe o aún no ha sido registrado en el sistema de la aerolínea.",
        suggestion: "Verifica que el número sea correcto o intenta más tarde.",
      };
    }
    if (err.includes("timeout") || err.includes("Timeout")) {
      return {
        title: "Tiempo de espera agotado",
        description: "La aerolínea tardó demasiado en responder.",
        suggestion: "El servicio puede estar lento. Intenta de nuevo en unos minutos.",
      };
    }
    if (err.includes("no disponible")) {
      return {
        title: "Servicio no disponible",
        description: "El tracking de esta aerolínea no está disponible temporalmente.",
        suggestion: "Intenta más tarde o contacta soporte si el problema persiste.",
      };
    }
    if (err.includes("Network") || err.includes("fetch")) {
      return {
        title: "Error de conexión",
        description: "No se pudo conectar con el servidor.",
        suggestion: "Verifica tu conexión a internet e intenta de nuevo.",
      };
    }
    return {
      title: "Error al procesar",
      description: err,
      suggestion: "Intenta de nuevo o contacta soporte si el problema persiste.",
    };
  };

  const errorInfo = getErrorInfo(error);

  return (
    <div className="w-full rounded-lg border border-red-200 bg-red-50 shadow-sm overflow-hidden">
      <div className="p-6">
        <div className="flex items-start gap-4">
          <div className="p-3 rounded-full bg-red-100 shrink-0">
            <AlertCircle className="h-6 w-6 text-red-600" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-mono text-lg font-bold text-red-900">{awb}</p>
                <p className="text-sm font-medium text-red-700 mt-1">{errorInfo.title}</p>
              </div>
              {onDismiss && (
                <button
                  onClick={onDismiss}
                  className="p-1 rounded hover:bg-red-100 text-red-400 hover:text-red-600"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <p className="text-sm text-red-600 mt-2">{errorInfo.description}</p>
            <p className="text-xs text-red-500 mt-2 italic">{errorInfo.suggestion}</p>
          </div>
        </div>
      </div>

      {onRetry && (
        <div className="border-t border-red-200 px-6 py-3 bg-red-100/50 flex items-center justify-between">
          <span className="text-xs text-red-600">¿El problema persiste?</span>
          <button
            onClick={onRetry}
            disabled={isRetrying}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`h-3 w-3 ${isRetrying ? "animate-spin" : ""}`} />
            {isRetrying ? "Reintentando..." : "Reintentar"}
          </button>
        </div>
      )}
    </div>
  );
}
