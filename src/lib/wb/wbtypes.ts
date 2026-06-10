// Wildberries Content API response/request shapes (subset we use).

export interface WbSubject {
  subjectID: number;
  subjectName: string;
  parentID: number;
  parentName: string;
}

export interface WbCharacteristic {
  charcID: number;
  subjectName: string;
  subjectID: number;
  name: string;
  required: boolean;
  unitName: string;
  maxCount: number;
  popular: boolean;
  charcType: number; // 1 = string, 4 = number (roughly)
}

export interface WbColor {
  name: string;
  parentName: string;
}

export interface WbCardVariantInput {
  vendorCode: string;
  title: string;
  description: string;
  brand: string;
  dimensions: {
    length: number;
    width: number;
    height: number;
    weightBrutto?: number;
  };
  characteristics: { id: number; value: string[] | number[] | string | number }[];
  sizes: {
    techSize?: string;
    wbSize?: string;
    price?: number;
    skus: string[];
  }[];
}

export interface WbCardUploadItem {
  subjectID: number;
  variants: WbCardVariantInput[];
}

export interface WbCardListItem {
  nmID: number;
  imtID: number;
  vendorCode: string;
  subjectID: number;
  subjectName: string;
  brand: string;
  title: string;
  photos?: { big: string; c246x328: string }[];
}

export interface WbCardError {
  vendorCode: string;
  errors: string[];
}

/** Raw shape of POST /content/v2/cards/error/list. */
export interface WbCardErrorListResponse {
  data?: {
    items?: {
      vendorCodes?: string[];
      errors?: Record<string, string[]>;
    }[];
  };
}
