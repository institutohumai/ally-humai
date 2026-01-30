# Usamos la imagen base oficial de AWS Lambda para Python 3.11
FROM public.ecr.aws/lambda/python:3.11

# Copiamos los archivos necesarios al directorio de trabajo de Lambda
COPY requirements.txt ${LAMBDA_TASK_ROOT}/
COPY bridge_server.py ${LAMBDA_TASK_ROOT}/
COPY import_candidates.py ${LAMBDA_TASK_ROOT}/


# Instalamos las dependencias dentro del contenedor
RUN pip install -r ${LAMBDA_TASK_ROOT}/requirements.txt

# Definimos el handler que AWS Lambda ejecutará
CMD [ "bridge_server.handler" ]