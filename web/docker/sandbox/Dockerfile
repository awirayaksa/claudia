# The image server-side code runs use (Admin → Settings → Code interpreter →
# "In a sandbox on the server"): Python 3.12 with the usual data packages,
# and Node.js 22. Runs start as the unprivileged user nobody (65534).
#
#   docker build -t claudia-sandbox web/docker/sandbox
#
# then set both images to claudia-sandbox in the admin settings. Without
# it, the defaults (python:3.12-slim, node:22-slim) work but have only the
# standard libraries.
FROM node:22-slim AS node

FROM python:3.12-slim
RUN pip install --no-cache-dir \
      numpy pandas scipy matplotlib seaborn \
      openpyxl xlsxwriter python-docx python-pptx pypdf \
      pillow tabulate sympy scikit-learn \
 && rm -rf /root/.cache
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV MPLBACKEND=Agg
WORKDIR /workspace
USER 65534:65534
