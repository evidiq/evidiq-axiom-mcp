export interface X402AssetAmount {
  asset: string;
  amount: string;
  extra?: {
    name: string;
    version: string;
  };
}

export interface X402AcceptRequirement {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: {
    name: string;
    version: string;
  };
}

export interface X402Challenge {
  x402Version: 2;
  resource: {
    url: string;
    description: string;
    mimeType: string;
  };
  accepts: X402AcceptRequirement[];
  error?: string;
}
