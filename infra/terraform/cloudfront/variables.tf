variable "aws_region" {
  description = "Region for provider operations. CloudFront itself is global."
  type        = string
  default     = "ap-south-1"
}

variable "web_origin_domain" {
  description = "Render web origin hostname without scheme or path."
  type        = string
  default     = "medinstru-web.onrender.com"
}

variable "api_origin_domain" {
  description = "Render API origin hostname without scheme or path."
  type        = string
  default     = "medinstru-api.onrender.com"
}

variable "web_aliases" {
  description = "Alternate domain names for the web distribution."
  type        = list(string)
  default     = []
}

variable "api_aliases" {
  description = "Alternate domain names for the API distribution."
  type        = list(string)
  default     = []
}

variable "web_certificate_arn" {
  description = "ACM certificate ARN in us-east-1 covering web_aliases. Required when web_aliases is non-empty."
  type        = string
  default     = null

  validation {
    condition     = length(var.web_aliases) == 0 || var.web_certificate_arn != null
    error_message = "web_certificate_arn is required when web_aliases is non-empty."
  }
}

variable "api_certificate_arn" {
  description = "ACM certificate ARN in us-east-1 covering api_aliases. Required when api_aliases is non-empty."
  type        = string
  default     = null

  validation {
    condition     = length(var.api_aliases) == 0 || var.api_certificate_arn != null
    error_message = "api_certificate_arn is required when api_aliases is non-empty."
  }
}

variable "price_class" {
  description = "CloudFront price class. PriceClass_All includes India and all US edge locations."
  type        = string
  default     = "PriceClass_All"
}

variable "tags" {
  description = "Tags applied to AWS resources."
  type        = map(string)
  default = {
    Application = "medinstru"
    ManagedBy   = "terraform"
  }
}
