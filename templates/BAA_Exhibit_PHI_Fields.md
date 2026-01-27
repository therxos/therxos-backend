# EXHIBIT A - Protected Health Information Data Elements

## Data Elements Accessed by Business Associate

The following Protected Health Information (PHI) data elements will be accessed, used, and/or disclosed by Business Associate (TheRxOS) in the course of providing services to Covered Entity:

### Prescription Data
| Field Name | Description |
|------------|-------------|
| Rx Number | Unique prescription identifier |
| Date Written | Date prescription was written by prescriber |
| DAW Code | Dispense As Written code |
| Dispensed Item Name | Name of the medication dispensed |
| Dispensed Item NDC | National Drug Code of dispensed medication |
| Dispensed Quantity | Quantity of medication dispensed |
| Dispensing Unit | Unit of measure for dispensed quantity |
| Days Supply | Number of days the prescription will last |
| Therapeutic Class Description | Drug classification category |
| PDC | Proportion of Days Covered (adherence metric) |

### Financial Data
| Field Name | Description |
|------------|-------------|
| Dispensed AWP | Average Wholesale Price of dispensed medication |
| Net Profit | Pharmacy profit on the prescription |
| Patient Paid Amount | Amount paid by patient (copay/coinsurance) |

### Insurance/Payer Data
| Field Name | Description |
|------------|-------------|
| Primary Contract ID | Insurance contract identifier |
| Primary Prescription Benefit Plan | Name of prescription benefit plan |
| Primary Third Party BIN | Bank Identification Number for claims processing |
| Primary Group Number | Insurance group number |
| Primary Network Reimbursement | Reimbursement amount from primary payer |

### Patient Data
| Field Name | Description |
|------------|-------------|
| Patient Full Name | Last name, First name |
| Patient Date of Birth | Patient's date of birth |
| Patient Age | Calculated age of patient |

### Prescriber Data
| Field Name | Description |
|------------|-------------|
| Prescriber Full Name | Name of prescribing provider |
| Prescriber Fax Number | Fax number for prescriber communications |

---

## Purpose of Data Access

Business Associate will use the above PHI data elements solely for the following purposes:
1. Identifying clinical optimization opportunities (therapeutic interchanges, missing therapies)
2. Generating prescriber outreach communications
3. Tracking opportunity outcomes and pharmacy revenue impact
4. Providing analytics and reporting to Covered Entity

## Data Security

All PHI data elements are:
- Encrypted in transit (TLS 1.2+) and at rest (AES-256)
- Stored in SOC 2 Type II compliant cloud infrastructure
- Accessible only to authorized personnel
- Subject to audit logging and access controls
