# Pokemon Market Data

## Summary
Pokemon Market Data is a comprehensive data collection and analysis system that scrapes Pokemon trading card prices and sales data from eBay and TCGPlayer. It uses web scraping, image processing, and machine learning to extract card information, grading certificates, and market pricing trends across multiple Pokemon card sets spanning from Base Set to recent releases.

## Session Summary
Implemented a comprehensive evaluation framework for the certificate extraction pipeline with `eval/measure_accuracy.py`. This tool measures extraction rate, exact-match accuracy, per-digit accuracy, and generates confusion matrices to identify which digit pairs are commonly misclassified. The evaluation system compares predictions against hand-labeled test sets, enabling quantitative assessment and targeted improvement of OCR accuracy.

## Features Registry
- eBay sold listings scraper with set-based organization (base1 through me3 sets)
- TCGPlayer CSV data fetching and card mapping system
- Image download pipeline for eBay listings with progress tracking
- YOLOv11 model training for PSA grading certificate detection with validation dataset
- Certificate extraction and OCR pipeline with success/failure categorization
- Price snapshot collection system with historical tracking (2026-04-11 onwards)
- Data persistence layer with JSON caching for eBay tokens and card mappings
- Unmatched sets tracking and error handling across scraping operations
- Distributed scraping coordinator using Google Sheets for task queue management
- Multi-scraper synchronization with claim tracking and stale claim detection
- Certificate extraction accuracy evaluation framework with confusion matrix analysis

## Completed
- [x] eBay sold listings scraper with set-based organization (base1 through me3 sets)
- [x] TCGPlayer CSV data fetching and card mapping system
- [x] Image download pipeline for eBay listings with progress tracking
- [x] YOLOv11 model training for PSA grading certificate detection with validation dataset
- [x] Certificate extraction and OCR pipeline with success/failure categorization
- [x] Price snapshot collection system with historical tracking (2026-04-11 onwards)
- [x] Data persistence layer with JSON caching for eBay tokens and card mappings
- [x] Unmatched sets tracking and error handling across scraping operations
- [x] Distributed scraping coordinator using Google Sheets for task queue management
- [x] Multi-scraper synchronization with claim tracking and stale claim detection
- [x] Certificate extraction accuracy evaluation framework with confusion matrix analysis

## In Progress
- [ ] Certificate OCR accuracy improvement and digit extraction refinement
- [ ] PSA grading label detection model evaluation and hyperparameter tuning
- [ ] Expansion of cert_results categorization (ocr_success, verify_later, unextractable)

## To Do
- [ ] Implement automated price trend analysis and anomaly detection across sets
- [ ] Build market analytics dashboard for price tracking and grade correlation
- [ ] Develop API endpoint for real-time price queries and historical comparisons
- [ ] Integrate additional grading body detection (BGS, CGC) beyond PSA certificates
- [ ] Create data export functionality for CSV/JSON reporting with filtering options
- [ ] Implement automated retraining pipeline for certificate detection model with new data
- [ ] Add comparator matching system to link individual cards across different seller listings
- [ ] Build notification system for price drops and market anomalies