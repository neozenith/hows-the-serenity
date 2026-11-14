variable "project" {
  description = "Short resource prefix. The Claude cloud worker may only manage resources named with it."
  type        = string
  default     = "hts"
}

variable "repo" {
  description = "Repository name, for tags"
  type        = string
  default     = "hows-the-serenity"
}

variable "aws_region" {
  description = "Region for everything except global services"
  type        = string
  default     = "ap-southeast-2"
}

variable "price_class" {
  description = "CloudFront edge footprint. PriceClass_100 is the cheapest; PriceClass_200 adds Australian edges."
  type        = string
  default     = "PriceClass_200"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be one of PriceClass_100, PriceClass_200, PriceClass_All."
  }
}
